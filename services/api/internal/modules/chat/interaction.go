package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

// 同一 Run 只允许一个恢复请求入队；ACK 丢失后的同答案重试不会重复执行。
func (m *RunManager) Respond(ctx context.Context, run *Run, interactionID string, answers []HITLAnswer) error {
	m.mu.Lock()
	current, exists := m.active[run.ID]
	if !exists {
		m.mu.Unlock()
		if run.Status == RunStatusWaitingUser {
			m.finishWithError(ctx, run, nil, &agent.Failure{Code: ErrorInteractionUnavailable,
				Message: "等待中的执行已失效，请重新发送任务"})
			m.discardCheckpoint(run.ID)
		}
		return interactionUnavailable()
	}
	defer m.mu.Unlock()
	if current.interaction == nil || current.interaction.id != interactionID || isTerminalRunStatus(run.Status) {
		return interactionUnavailable()
	}
	if err := validateInteractionAnswers(current.interaction.questions, answers); err != nil {
		return invalidEnvelope(err.Error())
	}
	raw, err := json.Marshal(answers)
	if err != nil {
		return err
	}
	if current.interaction.answer != nil {
		if bytes.Equal(current.interaction.answer, raw) {
			return nil
		}
		return interactionUnavailable()
	}
	current.interaction.answer = raw
	current.responses <- agent.ResumeInput{RunID: run.ID.String(), UserID: run.UserID.String(),
		ThreadID: run.ChatID.String(), InteractionID: interactionID, Answers: raw}
	return nil
}

func interactionUnavailable() *BusinessError {
	return newBusinessError(ErrorInteractionUnavailable, "当前交互已结束、已提交或不可恢复", false, http.StatusConflict)
}

func validateInteractionAnswers(questions []HITLQuestion, answers []HITLAnswer) error {
	if answers == nil || len(answers) > len(questions) {
		return fmt.Errorf("回答格式不合法")
	}
	byID := make(map[string]any, len(answers))
	for _, answer := range answers {
		if _, exists := byID[answer.QuestionID]; exists {
			return fmt.Errorf("问题不能重复回答")
		}
		known := false
		for _, question := range questions {
			if question.QuestionID == answer.QuestionID {
				known = true
				break
			}
		}
		if !known {
			return fmt.Errorf("回答包含未知问题")
		}
		byID[answer.QuestionID] = answer.Value
	}
	for _, question := range questions {
		answer, exists := byID[question.QuestionID]
		if !exists {
			if question.Required {
				return fmt.Errorf("请回答必填问题")
			}
			continue
		}
		values := []string{}
		if question.Multiple {
			items, ok := answer.([]any)
			if !ok || len(items) > 20 {
				return fmt.Errorf("多选答案格式不合法")
			}
			for _, item := range items {
				value, ok := item.(string)
				if !ok {
					return fmt.Errorf("多选答案必须是字符串")
				}
				values = append(values, value)
			}
		} else {
			value, ok := answer.(string)
			if !ok {
				return fmt.Errorf("答案必须是字符串")
			}
			values = append(values, value)
		}
		if question.Required && len(values) == 0 {
			return fmt.Errorf("请回答必填问题")
		}
		seen := map[string]bool{}
		for _, value := range values {
			limit := 8000
			if question.Multiple {
				limit = 500
			}
			if utf8.RuneCountInString(value) > limit {
				return fmt.Errorf("回答过长")
			}
			if question.Required && strings.TrimSpace(value) == "" {
				return fmt.Errorf("请回答必填问题")
			}
			if seen[value] {
				return fmt.Errorf("不能重复选择同一选项")
			}
			seen[value] = true
		}
	}
	return nil
}
