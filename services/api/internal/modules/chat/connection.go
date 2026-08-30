// 负责管理单条 WebSocket 连接的读取、单协程写入、心跳和发送队列。
package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// 浏览器单个文本帧最大允许 256 KiB，附件不能通过这里传输。
	maxFrameSize int64 = 256 * 1024

	// 有界队列可以防止慢客户端无限占用服务端内存。
	sendQueueSize = 64

	writeWait = 10 * time.Second
	pongWait  = 60 * time.Second
	pingEvery = 25 * time.Second
)

var (
	ErrConnectionClosed = errors.New("websocket connection is closed")
	ErrSendQueueFull    = errors.New("websocket send queue is full")
)

// FrameHandler 接收一整个 WebSocket 文本帧。
//
// func(...) 是函数类型，后续可以把 CommandRouter 的处理方法直接传进来。
// 这里的 Context 只属于当前连接，不能用它创建需要脱离连接继续运行的 Agent Run。
type FrameHandler func(
	ctx context.Context,
	connection *Connection,
	frame []byte,
)

// Connection 保存一条已经完成鉴权的 WebSocket 连接。
type Connection struct {
	id     string
	userID string

	socket *websocket.Conn
	send   chan any
	done   chan struct{}
	logger *slog.Logger

	// sync.Once 保证多个 goroutine 同时要求关闭时，清理逻辑只执行一次。
	closeOnce sync.Once
}

// NewConnection 创建连接对象，但不会自动开始读取消息。
func NewConnection(
	id string,
	userID string,
	socket *websocket.Conn,
	logger *slog.Logger,
) *Connection {
	if logger == nil {
		logger = slog.Default()
	}

	return &Connection{
		id:     id,
		userID: userID,
		socket: socket,
		send:   make(chan any, sendQueueSize), // 有缓冲 channel
		done:   make(chan struct{}),
		logger: logger,
	}
}

func (c *Connection) ID() string {
	return c.id
}

func (c *Connection) UserID() string {
	return c.userID
}

// Done 返回一个只读 channel。
// `<-chan` 表示调用方只能等待关闭信号，不能向这个 channel 写数据。
func (c *Connection) Done() <-chan struct{} {
	return c.done
}

// Send 把事件放入当前连接的发送队列。
//
// select 中的 default 让这里成为非阻塞操作：队列满时立即返回，
// 而不是卡住正在产生模型增量的 goroutine。
func (c *Connection) Send(frame any) error {
	select {
	case <-c.done:
		return ErrConnectionClosed
	default:
	}

	select {
	case c.send <- frame:
		return nil
	case <-c.done:
		return ErrConnectionClosed
	default:
		c.Close("send queue full")
		return ErrSendQueueFull
	}
}

// Serve 启动唯一的写入 goroutine，并在当前 goroutine 持续读取客户端帧。
//
// goroutine 是 Go 的轻量并发任务。这里始终只有 writeLoop 能写 socket，
// 避免多个事件生产者同时写 WebSocket 导致数据竞争。
func (c *Connection) Serve(
	ctx context.Context,
	handleFrame FrameHandler,
) error {
	writerDone := make(chan struct{})

	go func() {
		defer close(writerDone)

		if err := c.writeLoop(ctx); err != nil {
			c.logger.Debug(
				"websocket write loop stopped",
				"connection_id", c.id,
				"error", err,
			)
		}
		c.Close("writer stopped")
	}()

	readErr := c.readLoop(ctx, handleFrame)
	c.Close("reader stopped")

	// 等待写入 goroutine 退出，避免 Serve 返回后遗留连接级任务。
	<-writerDone

	if websocket.IsCloseError(
		readErr,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
	) {
		return nil
	}
	return readErr
}

// Close 可以由读循环、写循环、Hub 或 Handler 安全地重复调用。
func (c *Connection) Close(reason string) {
	c.closeOnce.Do(func() {
		close(c.done)

		deadline := time.Now().Add(writeWait)
		message := websocket.FormatCloseMessage(
			websocket.CloseNormalClosure,
			reason,
		)
		_ = c.socket.WriteControl(
			websocket.CloseMessage,
			message,
			deadline,
		)
		_ = c.socket.Close()

		c.logger.Info(
			"websocket connection closed",
			"connection_id", c.id,
			"user_id", c.userID,
			"reason", reason,
		)
	})
}

func (c *Connection) readLoop(
	ctx context.Context,
	handleFrame FrameHandler,
) error {
	c.socket.SetReadLimit(maxFrameSize)
	if err := c.socket.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		return fmt.Errorf("set websocket read deadline: %w", err)
	}

	// Gorilla 收到 Pong 控制帧时会调用这个函数，用于延长存活时间。
	c.socket.SetPongHandler(func(string) error {
		return c.socket.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		messageType, frame, err := c.socket.ReadMessage()
		if err != nil {
			return err
		}
		if messageType != websocket.TextMessage {
			return errors.New("only websocket text messages are supported")
		}

		// 保持顺序处理客户端指令，避免 submit 和 cancel 出现意外乱序。
		handleFrame(ctx, c, frame)
	}
}

func (c *Connection) writeLoop(ctx context.Context) error {
	pingTicker := time.NewTicker(pingEvery)
	defer pingTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.done:
			return nil
		case frame := <-c.send:
			if err := c.socket.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return fmt.Errorf("set websocket write deadline: %w", err)
			}
			if err := c.socket.WriteJSON(frame); err != nil {
				return fmt.Errorf("write websocket event: %w", err)
			}
		case <-pingTicker.C:
			deadline := time.Now().Add(writeWait)
			if err := c.socket.WriteControl(
				websocket.PingMessage,
				nil,
				deadline,
			); err != nil {
				return fmt.Errorf("write websocket ping: %w", err)
			}
		}
	}
}
