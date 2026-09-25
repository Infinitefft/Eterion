package chat

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestHistoryRequiresActiveRunCapability(t *testing.T) {
	runID := uuid.New()
	runs := NewRunManager(context.Background(), nil, nil, nil, nil)
	runs.active[runID] = activeRun{historyToken: "private-capability"}
	engine := gin.New()
	// Unauthorized requests must never reach the repository.
	RegisterHistoryRoute(engine, runs, nil)
	for _, token := range []string{"", "wrong-capability"} {
		request := httptest.NewRequest(http.MethodGet, "/internal/agent/runs/"+runID.String()+"/messages", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", response.Code)
		}
	}
	delete(runs.active, runID)
	request := httptest.NewRequest(http.MethodGet, "/internal/agent/runs/"+runID.String()+"/messages", nil)
	request.Header.Set("Authorization", "Bearer private-capability")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("ended run status = %d", response.Code)
	}
}

func TestPostgresHistoryPaginationStopsAtRunInput(t *testing.T) {
	db, userID := newIntegrationDatabase(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	chat := Chat{ID: uuid.New(), UserID: userID, Title: "history", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&chat).Error; err != nil {
		t.Fatal(err)
	}
	rows := make([]Message, 102)
	for index := range rows {
		created := now.Add(time.Duration(index) * time.Microsecond)
		rows[index] = Message{ID: uuid.New(), ChatID: chat.ID, Role: MessageRoleUser,
			Status: MessageStatusCompleted, Content: "history", ContentFormat: TextFormatPlainText,
			CreatedAt: created, UpdatedAt: created}
	}
	// Raw history keeps failed messages; Node, not the data endpoint, selects context.
	rows[0].Status = MessageStatusFailed
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	run := Run{UserID: userID, ChatID: chat.ID, InputMessageID: rows[100].ID}
	repository := NewRepository(db)
	first, err := repository.readHistoryPage(context.Background(), run, uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 100 || first.NextCursor == nil || first.Messages[0].Status != MessageStatusFailed {
		t.Fatal("first page must retain raw status and provide a cursor")
	}
	cursor, err := uuid.Parse(*first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	last, err := repository.readHistoryPage(context.Background(), run, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(last.Messages) != 1 || last.Messages[0].ID != run.InputMessageID || last.NextCursor != nil {
		t.Fatal("last page must include input exactly once and exclude later messages")
	}
	run.UserID = uuid.New()
	if _, err := repository.readHistoryPage(context.Background(), run, uuid.Nil); err != ErrRepositoryChatNotFound {
		t.Fatal("history must enforce conversation ownership")
	}
}
