package chat

import (
	"encoding/json"
	"fmt"
	"time"
)

func protocolRunError(run Run) *ProtocolError {
	if run.ErrorCode == nil {
		return nil
	}
	message := ""
	if run.ErrorMessage != nil {
		message = *run.ErrorMessage
	}
	return &ProtocolError{Code: *run.ErrorCode, Message: message}
}

func runStatusPayload(run Run) RunStatusPayload {
	return RunStatusPayload{
		Status: run.Status, ModelID: run.ModelID,
		InputMessageID: run.InputMessageID.String(), OutputMessageID: run.OutputMessageID.String(),
		CreatedAt: run.CreatedAt.UnixMilli(), StartedAt: timeMillisPointer(run.StartedAt),
		CompletedAt: timeMillisPointer(run.CompletedAt), Error: protocolRunError(run),
	}
}

func snapshotMessage(message Message, messageError *ProtocolError) SnapshotMessage {
	var runID *string
	if message.RunID != nil {
		value := message.RunID.String()
		runID = &value
	}
	format := message.ContentFormat
	if format == "" {
		format = TextFormatPlainText
	}
	return SnapshotMessage{
		ID: message.ID.String(), ThreadID: message.ChatID.String(), RunID: runID,
		Role: message.Role, Format: format, Content: message.Content, Status: message.Status,
		CreatedAt: message.CreatedAt.UnixMilli(), CompletedAt: timeMillisPointer(message.CompletedAt),
		Error: messageError,
	}
}

func snapshotRun(run Run) SnapshotRun {
	return SnapshotRun{
		ID: run.ID.String(), ThreadID: run.ChatID.String(), ModelID: run.ModelID,
		InputMessageID: run.InputMessageID.String(), OutputMessageID: run.OutputMessageID.String(),
		Status: run.Status, CreatedAt: run.CreatedAt.UnixMilli(),
		StartedAt: timeMillisPointer(run.StartedAt), CompletedAt: timeMillisPointer(run.CompletedAt),
		Error: protocolRunError(run),
	}
}

func snapshotBlock(block AgentBlock) (any, error) {
	switch block.Kind {
	case BlockKindThinking:
		var data thinkingBlockData
		if err := json.Unmarshal(block.Data, &data); err != nil {
			return nil, fmt.Errorf("decode thinking block %s: %w", block.ID, err)
		}
		return SnapshotThinkingBlock{
			Kind: BlockKindThinking, ID: block.ID, ThreadID: block.ChatID.String(),
			RunID: block.RunID.String(), Status: block.Status, Content: data.Content,
		}, nil
	case BlockKindTool:
		var data toolBlockData
		if err := json.Unmarshal(block.Data, &data); err != nil {
			return nil, fmt.Errorf("decode tool block %s: %w", block.ID, err)
		}
		return SnapshotToolBlock{
			Kind: BlockKindTool, ID: block.ID, ThreadID: block.ChatID.String(),
			RunID: block.RunID.String(), Status: block.Status, Name: data.Name,
			DisplayName: data.DisplayName, Args: data.Args, Summary: data.Summary,
			Result: data.Result, Error: data.Error,
		}, nil
	case BlockKindInteraction:
		var data interactionBlockData
		if err := json.Unmarshal(block.Data, &data); err != nil {
			return nil, fmt.Errorf("decode HITL block %s: %w", block.ID, err)
		}
		return SnapshotInteractionBlock{
			Kind: BlockKindInteraction, ID: block.ID, ThreadID: block.ChatID.String(),
			RunID: block.RunID.String(), Status: block.Status,
			Questions: data.Questions, Answers: data.Answers,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported agent block kind %q", block.Kind)
	}
}

func timeMillisPointer(value *time.Time) *int64 {
	if value == nil {
		return nil
	}
	millis := value.UnixMilli()
	return &millis
}
