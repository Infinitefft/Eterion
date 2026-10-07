package chat

import (
	"context"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

// 只合并相邻同类 delta；所有边界事件都先刷出文本，再沿用原来的事务和序号分配。
// 有界队列将 SSE 读取与写库解耦，不改变事件顺序，也不积累无限量的模型输出。
func consumeBatchedStream(ctx context.Context, produce func(context.Context, func(agent.Event) error) error, handle func(context.Context, agent.Event) error) error {
	streamCtx, cancel := context.WithCancel(ctx)
	events := make(chan agent.Event, 32)
	done := make(chan struct{})
	var producerErr error
	go func() {
		producerErr = produce(streamCtx, func(event agent.Event) error {
			select {
			case <-streamCtx.Done():
				return streamCtx.Err()
			case events <- event:
				return nil
			}
		})
		close(done)
		close(events)
	}()
	defer func() { cancel(); <-done }()

	var pending agent.Event
	var text strings.Builder
	var timer *time.Timer
	var tick <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
		}
		tick = nil
	}
	defer stopTimer()
	flush := func(flushCtx context.Context) error {
		stopTimer()
		if text.Len() == 0 {
			return nil
		}
		pending.Delta = text.String()
		text.Reset()
		if flushCtx.Err() != nil {
			var cleanupCancel context.CancelFunc
			flushCtx, cleanupCancel = context.WithTimeout(context.WithoutCancel(flushCtx), 5*time.Second)
			defer cleanupCancel()
		}
		return handle(flushCtx, pending)
	}
	for {
		select {
		case <-ctx.Done():
			// 终态处理也使用独立清理上下文；保留已经消费但尚未落库的最后一批文本。
			err := flush(ctx)
			if err != nil {
				return err
			}
			return ctx.Err()
		case <-tick:
			if err := flush(ctx); err != nil {
				return err
			}
		case event, ok := <-events:
			if !ok {
				if err := flush(ctx); err != nil {
					return err
				}
				<-done
				return producerErr
			}
			isDelta := event.Type == agent.EventThinkingDelta || event.Type == agent.EventContentDelta
			if !isDelta || (text.Len() > 0 && (pending.Type != event.Type || pending.RunID != event.RunID)) {
				if err := flush(ctx); err != nil {
					return err
				}
			}
			if !isDelta {
				if err := handle(ctx, event); err != nil {
					return err
				}
				continue
			}
			if event.Delta == "" {
				continue
			}
			if text.Len() == 0 {
				pending = event
				timer = time.NewTimer(30 * time.Millisecond)
				tick = timer.C
			}
			text.WriteString(event.Delta)
			if text.Len() >= 4096 {
				if err := flush(ctx); err != nil {
					return err
				}
			}
		}
	}
}
