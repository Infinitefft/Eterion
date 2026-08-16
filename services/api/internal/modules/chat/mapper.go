package chat

import "time"

func wireChatMessage(
	message Message,
	messageError *CommandError,
) WireChatMessage {
	var runID *string
	if message.RunID != nil {
		value := message.RunID.String()
		runID = &value
	}
	format := message.ContentFormat
	if format == "" {
		format = TextFormatPlainText
	}
	return WireChatMessage{
		MessageID: message.ID.String(),
		ChatID:    message.ChatID.String(),
		RunID:     runID,
		Role:      message.Role,
		Status:    message.Status,
		Content: TextContent{
			Type:    "text",
			Format:  format,
			Content: message.Content,
		},
		CreatedAt:   message.CreatedAt.UnixMilli(),
		UpdatedAt:   message.UpdatedAt.UnixMilli(),
		CompletedAt: timeMillisPointer(message.CompletedAt),
		Error:       messageError,
	}
}

func wireAgentRun(run Run) WireAgentRun {
	return WireAgentRun{
		RunID:           run.ID.String(),
		ChatID:          run.ChatID.String(),
		ModelID:         run.ModelID,
		InputMessageID:  run.InputMessageID.String(),
		OutputMessageID: run.OutputMessageID.String(),
		Status:          run.Status,
		StepIDs:         []string{},
		LastSeq:         run.LastSeq,
		Desynced:        false,
		CreatedAt:       run.CreatedAt.UnixMilli(),
		StartedAt:       timeMillisPointer(run.StartedAt),
		UpdatedAt:       run.UpdatedAt.UnixMilli(),
		CompletedAt:     timeMillisPointer(run.CompletedAt),
		Error:           runCommandError(run),
	}
}

func runCommandError(run Run) *CommandError {
	if run.ErrorCode == nil {
		return nil
	}
	errorMessage := ""
	if run.ErrorMessage != nil {
		errorMessage = *run.ErrorMessage
	}
	return &CommandError{
		Code:      *run.ErrorCode,
		Message:   errorMessage,
		Retryable: run.ErrorRetryable,
	}
}

func timeMillisPointer(value *time.Time) *int64 {
	if value == nil {
		return nil
	}
	millis := value.UnixMilli()
	return &millis
}

func snapshotMessage(message WireChatMessage) SnapshotMessage {
	return SnapshotMessage{
		ID:          message.MessageID,
		ChatID:      message.ChatID,
		RunID:       message.RunID,
		Role:        message.Role,
		Status:      message.Status,
		Content:     message.Content,
		CreatedAt:   message.CreatedAt,
		UpdatedAt:   message.UpdatedAt,
		CompletedAt: message.CompletedAt,
		Error:       message.Error,
	}
}

func snapshotRun(run WireAgentRun) SnapshotRun {
	return SnapshotRun{
		ID:              run.RunID,
		ChatID:          run.ChatID,
		ModelID:         run.ModelID,
		InputMessageID:  run.InputMessageID,
		OutputMessageID: run.OutputMessageID,
		Status:          run.Status,
		StepIDs:         run.StepIDs,
		LastSeq:         run.LastSeq,
		Desynced:        run.Desynced,
		CreatedAt:       run.CreatedAt,
		StartedAt:       run.StartedAt,
		UpdatedAt:       run.UpdatedAt,
		CompletedAt:     run.CompletedAt,
		Error:           run.Error,
	}
}
