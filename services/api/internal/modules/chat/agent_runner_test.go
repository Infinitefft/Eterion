// 负责验证 Go gRPC Runner 能鉴权并按顺序接收 Python Agent 协议事件。
package chat

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/gen/agentpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type fakeAgentGRPCServer struct {
	agentpb.UnimplementedAgentServiceServer
	expectedSecret string
}

func (s *fakeAgentGRPCServer) StreamRun(
	request *agentpb.RunRequest,
	stream grpc.ServerStreamingServer[agentpb.RunEvent],
) error {
	values := metadata.ValueFromIncomingContext(
		stream.Context(),
		"authorization",
	)
	if len(values) != 1 ||
		values[0] != "Bearer "+s.expectedSecret {
		return status.Error(codes.Unauthenticated, "invalid secret")
	}
	if request.GetRunId() == "" || request.GetChatId() == "" {
		return status.Error(codes.InvalidArgument, "missing IDs")
	}

	events := []*agentpb.RunEvent{
		{
			Payload: &agentpb.RunEvent_Started{
				Started: &agentpb.RunStarted{Model: "fake-model"},
			},
		},
		{
			Payload: &agentpb.RunEvent_ContentDelta{
				ContentDelta: &agentpb.ContentDelta{Delta: "你"},
			},
		},
		{
			Payload: &agentpb.RunEvent_ContentDelta{
				ContentDelta: &agentpb.ContentDelta{Delta: "好"},
			},
		},
		{
			Payload: &agentpb.RunEvent_Completed{
				Completed: &agentpb.RunCompleted{FullText: "你好"},
			},
		},
	}
	for _, event := range events {
		if err := stream.Send(event); err != nil {
			return err
		}
	}
	return nil
}

func TestGRPCRunnerStreamsAgentEvents(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	secret := "test-agent-secret-with-32-characters"
	server := grpc.NewServer()
	agentpb.RegisterAgentServiceServer(server, &fakeAgentGRPCServer{
		expectedSecret: secret,
	})
	go func() {
		_ = server.Serve(listener)
	}()
	defer server.Stop()

	runner, err := NewGRPCRunner(
		listener.Addr().String(),
		secret,
		2*time.Second,
	)
	if err != nil {
		t.Fatalf("create runner: %v", err)
	}
	defer func() {
		_ = runner.Close()
	}()

	received := make([]AgentEvent, 0, 4)
	err = runner.Run(context.Background(), AgentInput{
		RunID:  "run-1",
		ChatID: "chat-1",
		Messages: []AgentMessage{{
			Role:    "user",
			Content: "你好",
		}},
	}, func(event AgentEvent) error {
		received = append(received, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run stream: %v", err)
	}
	if len(received) != 4 {
		t.Fatalf("unexpected event count: %d", len(received))
	}
	if received[1].Delta != "你" ||
		received[2].Delta != "好" ||
		received[3].FullText != "你好" {
		t.Fatalf("unexpected events: %#v", received)
	}
}
