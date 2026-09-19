package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/agent/remote"
	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
)

type integrationAgentRequest struct {
	RunID    string          `json:"run_id"`
	UserID   string          `json:"user_id"`
	ThreadID string          `json:"thread_id"`
	ModelID  string          `json:"model_id"`
	Messages []agent.Message `json:"messages"`
}

type integrationFrame struct {
	Type            string          `json:"type"`
	OK              bool            `json:"ok"`
	RequestID       string          `json:"requestId"`
	CommandType     CommandType     `json:"commandType"`
	ThreadID        string          `json:"threadId"`
	RunID           string          `json:"runId"`
	MessageID       string          `json:"messageId"`
	InputMessageID  string          `json:"inputMessageId"`
	OutputMessageID string          `json:"outputMessageId"`
	ToolCallID      string          `json:"toolCallId"`
	SeqID           int64           `json:"seqId"`
	Timestamp       int64           `json:"timestamp"`
	Payload         json.RawMessage `json:"payload"`
	Error           *ProtocolError  `json:"error"`
}

type integrationSnapshot struct {
	Thread    SnapshotThread      `json:"thread"`
	Messages  []SnapshotMessage   `json:"messages"`
	Runs      []SnapshotRun       `json:"runs"`
	Blocks    []SnapshotToolBlock `json:"blocks"`
	LastSeqID int64               `json:"lastSeqId"`
}

type integrationChat struct {
	t         *testing.T
	db        *gorm.DB
	userID    uuid.UUID
	server    *httptest.Server
	socket    *websocket.Conn
	requests  chan integrationAgentRequest
	cancelled chan string
	frames    []integrationFrame
	sequences map[string]int64
}

func newIntegrationChat(t *testing.T) *integrationChat {
	t.Helper()
	db, userID := newIntegrationDatabase(t)
	h := &integrationChat{
		t: t, db: db, userID: userID,
		requests: make(chan integrationAgentRequest, 8), cancelled: make(chan string, 8),
		sequences: make(map[string]int64),
	}
	upstream := httptest.NewServer(http.HandlerFunc(h.serveAgent))
	t.Cleanup(upstream.Close)
	runner, err := remote.NewRunner(context.Background(), remote.Config{
		BaseURL: upstream.URL, ConnectTimeout: 3 * time.Second, RunTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	publisher := NewPublisher(hub)
	repository := NewRepository(db)
	service := NewService(repository)
	appContext, stopApp := context.WithCancel(context.Background())
	runs := NewRunManager(appContext, repository, runner, publisher, logger)
	commands := NewCommandRouter(service, runs, publisher, logger, runner)
	const origin = "http://im-integration.test"
	handler := NewHandler(service, NewTicketService(time.Minute), hub, publisher, commands,
		config.Config{AllowedOrigins: []string{origin}}, logger, runner)
	engine := gin.New()
	// Authentication is already covered separately. Only this test server injects
	// its seeded identity; ticket creation, ticket consumption and WS are real.
	handler.RegisterRoutes(engine.Group("/api"), func(c *gin.Context) {
		c.Set("eterion.auth.identity", &auth.Identity{UserID: userID})
		c.Next()
	})
	h.server = httptest.NewServer(engine)
	h.server.Client().Timeout = 10 * time.Second
	t.Cleanup(func() {
		if h.socket != nil {
			_ = h.socket.Close()
		}
		stopApp()
		_ = runs.Close()
		hub.CloseAll("integration test finished")
		h.server.Close()
	})
	request, err := http.NewRequest(http.MethodPost, h.server.URL+"/api/chat/ticket", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := h.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("ticket HTTP status = %d", response.StatusCode)
	}
	var ticket struct {
		Data TicketResponse `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&ticket); err != nil {
		t.Fatal(err)
	}
	h.socket, _, err = websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(h.server.URL, "http")+"/api/chat/ws?ticket="+ticket.Data.Ticket,
		http.Header{"Origin": []string{origin}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// The fake replaces only Node/model work. Requests still cross real HTTP/SSE,
// RunManager, PostgreSQL, Publisher and the browser-facing WebSocket boundary.
func (h *integrationChat) serveAgent(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/models" {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"default_model_id":"test-model","models":[{"id":"test-model","modelName":"Offline model","provider":"fixture","providerName":"Fixture","icon_url":""}]}`)
		return
	}
	var input integrationAgentRequest
	if r.Method != http.MethodPost || r.URL.Path != "/runs" ||
		json.NewDecoder(r.Body).Decode(&input) != nil || len(input.Messages) == 0 {
		http.Error(w, "invalid fixture request", http.StatusBadRequest)
		return
	}
	h.requests <- input
	w.Header().Set("Content-Type", "text/event-stream")
	emit := func(name string, payload any) {
		data, err := json.Marshal(map[string]any{"runId": input.RunID, "payload": payload})
		if err != nil {
			h.t.Errorf("encode fixture SSE: %v", err)
			return
		}
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data)
		w.(http.Flusher).Flush()
	}
	emit("run.started", map[string]any{"modelId": input.ModelID})
	emit("content.started", map[string]any{"format": "markdown"})
	question := input.Messages[len(input.Messages)-1].Content
	if question == "cancel-tool" || question == "fail-tool" {
		for _, id := range []string{"completed-search", "failed-search", "active-search"} {
			emit("tool.started", map[string]any{
				"toolCallId": id, "name": "web_search", "displayName": "搜索网页", "args": map[string]any{"query": id},
			})
			if id == "completed-search" {
				emit("tool.completed", map[string]any{"toolCallId": id, "summary": "saved result", "result": map[string]any{"title": "saved title"}})
			} else if id == "failed-search" {
				emit("tool.failed", map[string]any{"toolCallId": id, "error": map[string]any{"code": "TOOL_FAILED", "message": "saved failure", "retryable": false}})
			}
		}
	}
	if strings.HasPrefix(question, "cancel-") || strings.HasPrefix(question, "fail-") {
		emit("content.delta", map[string]any{"delta": "partial answer"})
		if strings.HasPrefix(question, "cancel-") {
			<-r.Context().Done()
			h.cancelled <- input.RunID
			return
		}
		failure := map[string]any{"code": "FIXTURE_FAILED", "message": "safe fixture failure", "retryable": true}
		emit("content.completed", map[string]any{"content": "partial answer", "format": "markdown", "status": "failed", "error": failure})
		emit("run.failed", map[string]any{"error": failure})
		return
	}
	emit("content.delta", map[string]any{"delta": "reply:"})
	emit("content.delta", map[string]any{"delta": question})
	emit("content.completed", map[string]any{"content": "reply:" + question, "format": "markdown", "status": "completed", "error": nil})
	emit("run.completed", map[string]any{})
}

func decodeIntegrationPayload[T any](t *testing.T, frame integrationFrame) T {
	t.Helper()
	var payload T
	if err := json.Unmarshal(frame.Payload, &payload); err != nil {
		t.Fatalf("decode %s payload: %v", frame.Type, err)
	}
	return payload
}

func (h *integrationChat) readUntil(match func(integrationFrame) bool) integrationFrame {
	h.t.Helper()
	for {
		if err := h.socket.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
			h.t.Fatal(err)
		}
		var frame integrationFrame
		if err := h.socket.ReadJSON(&frame); err != nil {
			h.t.Fatalf("read IM frame: %v", err)
		}
		if frame.Timestamp <= 0 {
			h.t.Fatalf("frame omitted server timestamp: %+v", frame)
		}
		if frame.Type != "ack" {
			last := h.sequences[frame.ThreadID]
			if frame.ThreadID == "" || frame.SeqID != last+1 {
				h.t.Fatalf("thread event sequence = %d after %d (%s)", frame.SeqID, last, frame.Type)
			}
			h.sequences[frame.ThreadID] = frame.SeqID
		}
		h.frames = append(h.frames, frame)
		if match(frame) {
			return frame
		}
	}
}

func (h *integrationChat) command(command ClientCommand) integrationFrame {
	h.t.Helper()
	if err := h.socket.WriteJSON(command); err != nil {
		h.t.Fatal(err)
	}
	ack := h.readUntil(func(frame integrationFrame) bool { return frame.Type == "ack" && frame.RequestID == command.RequestID })
	if !ack.OK || ack.Error != nil || ack.CommandType != command.Type || ack.ThreadID != command.ThreadID || ack.RunID == "" {
		h.t.Fatalf("unexpected ACK: %+v", ack)
	}
	return ack
}

func (h *integrationChat) submit(kind CommandType, threadID, question string) integrationFrame {
	h.t.Helper()
	messageID := uuid.NewString()
	payload, err := json.Marshal(MessageCommandPayload{Content: question})
	if err != nil {
		h.t.Fatal(err)
	}
	ack := h.command(ClientCommand{Type: kind, RequestID: uuid.NewString(), ThreadID: threadID, MessageID: messageID, Payload: payload})
	if ack.InputMessageID != messageID || ack.OutputMessageID == "" || ack.OutputMessageID == messageID {
		h.t.Fatalf("ACK lost message identities: %+v", ack)
	}
	return ack
}

func (h *integrationChat) waitTerminal(ack integrationFrame, status RunStatus) {
	h.t.Helper()
	match := func(frame integrationFrame) bool {
		if frame.Type != string(EventRunStatus) || frame.RunID != ack.RunID {
			return false
		}
		payload := decodeIntegrationPayload[RunStatusPayload](h.t, frame)
		if !isTerminalRunStatus(payload.Status) {
			return false
		}
		if payload.Status != status || payload.InputMessageID != ack.InputMessageID ||
			payload.OutputMessageID != ack.OutputMessageID || payload.ModelID != "test-model" || payload.CompletedAt == nil {
			h.t.Fatalf("unexpected terminal Run: %+v", payload)
		}
		return true
	}
	for _, frame := range h.frames {
		if match(frame) {
			return
		}
	}
	h.readUntil(match)
}

func (h *integrationChat) snapshot(threadID string) integrationSnapshot {
	h.t.Helper()
	response, err := h.server.Client().Get(h.server.URL + "/api/chat/" + threadID + "/snapshot")
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		h.t.Fatalf("snapshot HTTP status = %d", response.StatusCode)
	}
	var envelope struct {
		Data integrationSnapshot `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		h.t.Fatal(err)
	}
	if envelope.Data.Thread.ID != threadID || envelope.Data.LastSeqID != h.sequences[threadID] {
		h.t.Fatalf("snapshot cursor does not match delivered events: %+v", envelope.Data)
	}
	for index := len(h.frames) - 1; index >= 0; index-- {
		frame := h.frames[index]
		if frame.ThreadID != threadID || frame.Type != string(EventThreadUpdated) {
			continue
		}
		payload := decodeIntegrationPayload[ThreadUpdatedPayload](h.t, frame)
		thread := envelope.Data.Thread
		if thread.Title != payload.Title || thread.CreatedAt != payload.CreatedAt || thread.UpdatedAt != payload.UpdatedAt {
			h.t.Fatalf("snapshot Thread differs from latest thread.updated: snapshot=%+v event=%+v", thread, payload)
		}
		return envelope.Data
	}
	h.t.Fatal("snapshot Thread has no matching thread.updated event")
	return integrationSnapshot{}
}

func (h *integrationChat) checkTerminal(ack integrationFrame, status RunStatus, content, errorCode string) integrationSnapshot {
	h.t.Helper()
	h.waitTerminal(ack, status)
	snapshot := h.snapshot(ack.ThreadID)
	messageStatus := MessageStatus(status)
	var completed *integrationFrame
	var terminalRun *integrationFrame
	for index := range h.frames {
		frame := &h.frames[index]
		if frame.Type == string(EventMessageCompleted) && frame.MessageID == ack.OutputMessageID {
			if completed != nil {
				h.t.Fatal("assistant received multiple completion events")
			}
			completed = frame
		}
		if frame.RunID == ack.RunID && (frame.Type == string(EventMessageDelta) || frame.Type == string(EventMessageStarted)) && frame.MessageID != ack.OutputMessageID {
			h.t.Fatal("streaming message ID differs from ACK outputMessageId")
		}
		if frame.RunID == ack.RunID && frame.Type == string(EventRunStatus) &&
			isTerminalRunStatus(decodeIntegrationPayload[RunStatusPayload](h.t, *frame).Status) {
			if terminalRun != nil {
				h.t.Fatal("Run received multiple terminal events")
			}
			terminalRun = frame
		}
	}
	if completed == nil || completed.RunID != ack.RunID || terminalRun == nil {
		h.t.Fatal("missing assistant completion")
	}
	if terminalRun.SeqID != completed.SeqID+1 {
		h.t.Fatal("Run terminal must immediately follow assistant completion")
	}
	finalMessage := decodeIntegrationPayload[MessageCompletedPayload](h.t, *completed)
	if finalMessage.Status != messageStatus || finalMessage.Content != content || finalMessage.Role != MessageRoleAssistant ||
		finalMessage.Format != TextFormatMarkdown || finalMessage.CompletedAt <= 0 {
		h.t.Fatalf("unexpected completed message: %+v", finalMessage)
	}
	if errorCode == "" && finalMessage.Error != nil || errorCode != "" && (finalMessage.Error == nil || finalMessage.Error.Code != errorCode) {
		h.t.Fatalf("unexpected completed message error: %+v", finalMessage.Error)
	}
	found := false
	for _, message := range snapshot.Messages {
		if message.ID == ack.OutputMessageID {
			found = true
			if message.Status != messageStatus || message.Content != content || message.RunID == nil || *message.RunID != ack.RunID || !reflect.DeepEqual(message.Error, finalMessage.Error) {
				h.t.Fatalf("snapshot message differs from WS completion: %+v", message)
			}
		}
	}
	if !found {
		h.t.Fatal("snapshot omitted completed assistant")
	}
	found = false
	for _, run := range snapshot.Runs {
		if run.ID == ack.RunID {
			found = true
			if run.Status != status || run.ThreadID != ack.ThreadID || run.ModelID != "test-model" ||
				run.InputMessageID != ack.InputMessageID || run.OutputMessageID != ack.OutputMessageID ||
				!reflect.DeepEqual(run.Error, finalMessage.Error) {
				h.t.Fatalf("snapshot Run differs from WS terminal: %+v", run)
			}
		}
	}
	if !found {
		h.t.Fatal("snapshot omitted terminal Run")
	}
	var savedMessage Message
	if err := h.db.First(&savedMessage, "id = ?", ack.OutputMessageID).Error; err != nil {
		h.t.Fatal(err)
	}
	var savedRun Run
	if err := h.db.First(&savedRun, "id = ?", ack.RunID).Error; err != nil {
		h.t.Fatal(err)
	}
	if savedMessage.Status != messageStatus || savedMessage.Content != content || savedRun.Status != status ||
		savedRun.InputMessageID.String() != ack.InputMessageID || savedRun.OutputMessageID.String() != ack.OutputMessageID {
		h.t.Fatalf("DB terminal state differs: message=%+v run=%+v", savedMessage, savedRun)
	}
	return snapshot
}

func (h *integrationChat) checkRepeatedCancel(ack integrationFrame, before integrationSnapshot) {
	h.t.Helper()
	for range 2 {
		frameCount := len(h.frames)
		h.command(ClientCommand{Type: CommandRunCancel, RequestID: uuid.NewString(), ThreadID: ack.ThreadID, RunID: ack.RunID})
		if len(h.frames) != frameCount+1 {
			h.t.Fatal("cancelling terminal Run must only acknowledge the command")
		}
		after := h.snapshot(ack.ThreadID)
		if !reflect.DeepEqual(before, after) {
			h.t.Fatalf("cancelling terminal Run changed its snapshot: before=%+v after=%+v", before, after)
		}
	}
}

func TestPostgresIMTwoRoundsKeepIdentityAndSequence(t *testing.T) {
	h := newIntegrationChat(t)
	threadID := uuid.NewString()
	first := h.submit(CommandThreadStart, threadID, "first")
	h.checkTerminal(first, RunStatusCompleted, "reply:first", "")
	second := h.submit(CommandMessageSend, threadID, "second")
	snapshot := h.checkTerminal(second, RunStatusCompleted, "reply:second", "")
	if first.RunID == second.RunID || first.OutputMessageID == second.OutputMessageID || len(snapshot.Messages) != 4 || len(snapshot.Runs) != 2 {
		t.Fatalf("two rounds did not remain distinct: %+v", snapshot)
	}
	for index, ack := range []integrationFrame{first, second} {
		select {
		case input := <-h.requests:
			if input.RunID != ack.RunID || input.ThreadID != threadID || input.UserID != h.userID.String() || input.ModelID != "test-model" {
				t.Fatalf("upstream request lost identity: %+v", input)
			}
			want := []agent.Message{{Role: "user", Content: "first"}}
			if index == 1 {
				want = append(want, agent.Message{Role: "assistant", Content: "reply:first"}, agent.Message{Role: "user", Content: "second"})
			}
			if !reflect.DeepEqual(input.Messages, want) {
				t.Fatalf("upstream history = %+v, want %+v", input.Messages, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("missing upstream request")
		}
	}
	h.checkRepeatedCancel(second, snapshot)
}

func TestPostgresIMFailureAndCancellation(t *testing.T) {
	for _, scenario := range []struct {
		question  string
		status    RunStatus
		errorCode string
	}{
		{"fail-content", RunStatusFailed, "FIXTURE_FAILED"},
		{"cancel-content", RunStatusCancelled, ""},
		{"cancel-tool", RunStatusCancelled, ""},
		{"fail-tool", RunStatusFailed, "FIXTURE_FAILED"},
	} {
		t.Run(scenario.question, func(t *testing.T) {
			h := newIntegrationChat(t)
			ack := h.submit(CommandThreadStart, uuid.NewString(), scenario.question)
			if scenario.status == RunStatusCancelled {
				h.readUntil(func(frame integrationFrame) bool {
					return frame.Type == string(EventMessageDelta) && frame.RunID == ack.RunID
				})
				h.command(ClientCommand{Type: CommandRunCancel, RequestID: uuid.NewString(), ThreadID: ack.ThreadID, RunID: ack.RunID})
				select {
				case runID := <-h.cancelled:
					if runID != ack.RunID {
						t.Fatal("cancel reached a different upstream Run")
					}
				case <-time.After(3 * time.Second):
					t.Fatal("run.cancel did not abort upstream HTTP context")
				}
			}
			snapshot := h.checkTerminal(ack, scenario.status, "partial answer", scenario.errorCode)
			if strings.HasSuffix(scenario.question, "tool") {
				h.checkToolTerminals(ack, snapshot, scenario.status)
			}
			h.checkRepeatedCancel(ack, snapshot)
		})
	}
}

func (h *integrationChat) checkToolTerminals(ack integrationFrame, snapshot integrationSnapshot, status RunStatus) {
	h.t.Helper()
	if len(snapshot.Blocks) != 3 {
		h.t.Fatalf("snapshot blocks = %d, want 3", len(snapshot.Blocks))
	}
	for _, block := range snapshot.Blocks {
		if block.Kind != BlockKindTool || block.RunID != ack.RunID || block.ThreadID != ack.ThreadID {
			h.t.Fatalf("invalid tool identity: %+v", block)
		}
		wantStatus, wantCode := "failed", "TOOL_FAILED"
		switch block.ID {
		case "completed-search":
			wantStatus, wantCode = "completed", ""
			if block.Summary == nil || *block.Summary != "saved result" || !reflect.DeepEqual(block.Result, map[string]any{"title": "saved title"}) {
				h.t.Fatalf("completed Tool result was overwritten: %+v", block)
			}
		case "active-search":
			wantCode = "FIXTURE_FAILED"
			if status == RunStatusCancelled {
				wantCode = "RUN_CANCELLED"
			}
		case "failed-search":
			if block.Error == nil || block.Error.Message != "saved failure" {
				h.t.Fatalf("existing Tool failure was overwritten: %+v", block)
			}
		default:
			h.t.Fatalf("unexpected tool ID %q", block.ID)
		}
		if block.Status != wantStatus || wantCode == "" && block.Error != nil || wantCode != "" && (block.Error == nil || block.Error.Code != wantCode) {
			h.t.Fatalf("unexpected Tool terminal: %+v", block)
		}
		terminalCount := 0
		for _, frame := range h.frames {
			if frame.ToolCallID != block.ID || frame.RunID != ack.RunID || (frame.Type != string(EventToolFailed) && frame.Type != string(EventToolCompleted)) {
				continue
			}
			terminalCount++
			if frame.Type == string(EventToolFailed) {
				payload := decodeIntegrationPayload[ToolFailedPayload](h.t, frame)
				if !reflect.DeepEqual(&payload.Error, block.Error) {
					h.t.Fatal("Tool failure differs between WS and snapshot")
				}
			}
		}
		if terminalCount != 1 {
			h.t.Fatalf("Tool %s has %d terminal events", block.ID, terminalCount)
		}
		var stored AgentBlock
		if err := h.db.First(&stored, "run_id = ? AND id = ?", ack.RunID, block.ID).Error; err != nil {
			h.t.Fatal(err)
		}
		mapped, err := snapshotBlock(stored)
		if err != nil {
			h.t.Fatal(err)
		}
		if !reflect.DeepEqual(mapped, block) {
			h.t.Fatalf("DB Tool differs from snapshot: %+v / %+v", mapped, block)
		}
	}
	// Run/Message end only after outstanding tool lifecycle events are delivered.
	last := make([]integrationFrame, 0, 3)
	for _, frame := range h.frames {
		if frame.Type != "ack" {
			last = append(last, frame)
		}
	}
	last = last[len(last)-3:]
	if last[0].Type != string(EventToolFailed) || last[0].ToolCallID != "active-search" ||
		last[1].Type != string(EventMessageCompleted) || last[2].Type != string(EventRunStatus) {
		h.t.Fatalf("wrong terminal event order: %+v", last)
	}
}
