// 负责通过 gRPC 调用 Python Agent，并转换其流式返回事件。
package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/gen/agentpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type AgentMessage struct {
	Role    string
	Content string
}

type AgentInput struct {
	RunID    string
	ChatID   string
	Messages []AgentMessage
}

type AgentEventType string

const (
	AgentEventStarted   AgentEventType = "started"
	AgentEventDelta     AgentEventType = "content_delta"
	AgentEventCompleted AgentEventType = "completed"
)

type AgentEvent struct {
	Type     AgentEventType
	Model    string
	Delta    string
	FullText string
}

// AgentFailure 表示 Python 已经正常返回了结构化失败事件。
type AgentFailure struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *AgentFailure) Error() string {
	return e.Code + ": " + e.Message
}

// Runner 隔离具体的 Python 和 gRPC 实现。
// handle 会按 Python 返回顺序逐个接收事件。
type Runner interface {
	Run(
		ctx context.Context,
		input AgentInput,
		handle func(AgentEvent) error,
	) error
	Close() error
}

type GRPCRunner struct {
	connection   *grpc.ClientConn
	client       agentpb.AgentServiceClient
	sharedSecret string
	timeout      time.Duration
}

func NewGRPCRunner(
	address string,
	sharedSecret string,
	timeout time.Duration,
) (*GRPCRunner, error) {
	// 当前 Python Agent 只监听内网地址，因此第一阶段使用明文 gRPC。
	// 如果未来跨主机部署，应改成 TLS 凭证。
	connection, err := grpc.NewClient(
		address,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(4*1024*1024),
			grpc.MaxCallSendMsgSize(4*1024*1024),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("create agent gRPC client: %w", err)
	}

	return &GRPCRunner{
		connection:   connection,
		client:       agentpb.NewAgentServiceClient(connection),
		sharedSecret: sharedSecret,
		timeout:      timeout,
	}, nil
}

func (r *GRPCRunner) Run(
	ctx context.Context,
	input AgentInput,
	handle func(AgentEvent) error,
) error {
	runCtx := ctx
	cancel := func() {}
	if r.timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, r.timeout)
	}
	defer cancel()

	// metadata 相当于 gRPC 请求头，用于证明调用来自 Go API。
	runCtx = metadata.AppendToOutgoingContext(
		runCtx,
		"authorization",
		"Bearer "+r.sharedSecret,
	)

	messages := make([]*agentpb.ChatMessage, 0, len(input.Messages))
	for _, message := range input.Messages {
		messages = append(messages, &agentpb.ChatMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}

	stream, err := r.client.StreamRun(runCtx, &agentpb.RunRequest{
		RunId:    input.RunID,
		ChatId:   input.ChatID,
		Messages: messages,
	})
	if err != nil {
		return fmt.Errorf("start agent stream: %w", err)
	}

	completed := false
	for {
		event, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			if !completed {
				return errors.New("agent stream ended before completed event")
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("receive agent stream: %w", err)
		}
		if completed {
			return errors.New("agent returned an event after completion")
		}

		switch payload := event.Payload.(type) {
		case *agentpb.RunEvent_Started:
			if err := handle(AgentEvent{
				Type:  AgentEventStarted,
				Model: payload.Started.Model,
			}); err != nil {
				return err
			}
		case *agentpb.RunEvent_ContentDelta:
			if payload.ContentDelta.Delta == "" {
				continue
			}
			if err := handle(AgentEvent{
				Type:  AgentEventDelta,
				Delta: payload.ContentDelta.Delta,
			}); err != nil {
				return err
			}
		case *agentpb.RunEvent_Completed:
			completed = true
			if err := handle(AgentEvent{
				Type:     AgentEventCompleted,
				FullText: payload.Completed.FullText,
			}); err != nil {
				return err
			}
		case *agentpb.RunEvent_Failed:
			return &AgentFailure{
				Code:      payload.Failed.Code,
				Message:   payload.Failed.Message,
				Retryable: payload.Failed.Retryable,
			}
		default:
			return errors.New("agent returned an unknown event")
		}
	}
}

func (r *GRPCRunner) Close() error {
	return r.connection.Close()
}
