package chat

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Every test owns a schema. The supplied database can contain development data;
// migrations and cleanup are confined to this randomly named schema.
func newIntegrationDatabase(t *testing.T) (*gorm.DB, uuid.UUID) {
	t.Helper()
	dsn := os.Getenv("ETERION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ETERION_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	configuration, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid ETERION_TEST_DATABASE_URL")
	}
	admin := stdlib.OpenDB(*configuration)
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	schema := "eterion_im_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatalf("create integration schema: %v", err)
	}
	t.Cleanup(func() {
		if !strings.HasPrefix(schema, "eterion_im_test_") || len(schema) != len("eterion_im_test_")+32 {
			t.Error("refusing to clean unexpected integration schema")
			return
		}
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.ExecContext(cleanupContext, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("clean integration schema: %v", err)
		}
	})
	configuration.RuntimeParams["search_path"] = schema
	connection := stdlib.OpenDB(*configuration)
	connection.SetMaxOpenConns(4)
	t.Cleanup(func() { _ = connection.Close() })
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: connection}), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	_, currentFile, _, _ := runtime.Caller(0)
	migrations, err := filepath.Glob(filepath.Join(filepath.Dir(currentFile), "..", "..", "..", "migrations", "*.sql"))
	if err != nil || len(migrations) == 0 {
		t.Fatalf("find repository migrations: %v", err)
	}
	for _, path := range migrations {
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		_, up, ok := strings.Cut(string(contents), "-- +goose Up")
		if !ok {
			t.Fatalf("migration %s has no Up section", filepath.Base(path))
		}
		up, _, _ = strings.Cut(up, "-- +goose Down")
		if _, err := connection.ExecContext(ctx, up); err != nil {
			t.Fatalf("apply %s: %v", filepath.Base(path), err)
		}
	}
	userID := uuid.New()
	if err := db.WithContext(ctx).Exec(`
		INSERT INTO users (id, phone, nickname, nickname_normalized, password_hash, created_at, updated_at)
		VALUES (?, '13800000000', 'IM Test', 'im test', 'fixture-password-hash', NOW(), NOW())
	`, userID).Error; err != nil {
		t.Fatalf("seed integration user: %v", err)
	}
	return db, userID
}

func TestPostgresSnapshotUsesOneCommittedView(t *testing.T) {
	db, userID := newIntegrationDatabase(t)
	repository := NewRepository(db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Now().UTC()
	messageID := uuid.New()
	record, err := repository.StartChat(ctx, userID, uuid.New(), messageID,
		messageID.String(), "test-model", "Snapshot", "question", TextFormatPlainText, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReserveSubmitEvents(ctx, record.Run.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repository.TransitionRun(ctx, record.Run.ID,
		[]RunStatus{RunStatusPending}, RunStatusRunning, now); err != nil {
		t.Fatal(err)
	}
	beforeSequence, err := repository.StartMessage(ctx, record.Run.ID,
		record.Run.OutputMessageID, TextFormatMarkdown, now)
	if err != nil {
		t.Fatal(err)
	}

	// Pause only this snapshot after its first SELECT. A second connection commits
	// a delta before the remaining SELECTs, exposing READ COMMITTED mixed snapshots.
	type snapshotBarrierKey struct{}
	chatRead := make(chan struct{})
	continueRead := make(chan struct{})
	var once sync.Once
	callbackName := "integration:snapshot_barrier"
	if err := db.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != "chats" || tx.Statement.Context.Value(snapshotBarrierKey{}) != true {
			return
		}
		once.Do(func() {
			close(chatRead)
			select {
			case <-continueRead:
			case <-ctx.Done():
				tx.AddError(ctx.Err())
			}
		})
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })
	type snapshotResult struct {
		value *SnapshotResponse
		err   error
	}
	finished := make(chan snapshotResult, 1)
	go func() {
		value, err := NewService(repository).Snapshot(
			context.WithValue(ctx, snapshotBarrierKey{}, true), userID, record.Chat.ID)
		finished <- snapshotResult{value, err}
	}()
	select {
	case <-chatRead:
	case <-ctx.Done():
		t.Fatal("snapshot did not reach its first SELECT")
	}
	afterSequence, err := repository.AppendDelta(ctx, record.Run.ID,
		record.Run.OutputMessageID, "committed while reading", now.Add(time.Millisecond))
	close(continueRead)
	if err != nil {
		t.Fatal(err)
	}
	var before *SnapshotResponse
	select {
	case result := <-finished:
		if result.err != nil {
			t.Fatal(result.err)
		}
		before = result.value
	case <-ctx.Done():
		t.Fatal("snapshot did not finish")
	}
	after, err := NewService(repository).Snapshot(ctx, userID, record.Chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		snapshot *SnapshotResponse
		sequence int64
		content  string
	}{{before, beforeSequence, ""}, {after, afterSequence, "committed while reading"}} {
		if check.snapshot.LastSeqID != check.sequence {
			t.Fatalf("snapshot cursor = %d, want %d", check.snapshot.LastSeqID, check.sequence)
		}
		found := false
		for _, message := range check.snapshot.Messages {
			if message.ID == record.Run.OutputMessageID.String() {
				found = true
				if message.Content != check.content {
					t.Fatalf("cursor %d contains %q, want %q", check.sequence, message.Content, check.content)
				}
			}
		}
		if !found {
			t.Fatal("snapshot omitted the streaming assistant message")
		}
	}
	if afterSequence != beforeSequence+1 {
		t.Fatalf("delta sequence = %d after %d", afterSequence, beforeSequence)
	}
}
