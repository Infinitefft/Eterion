// 负责签发和消费短时、一次性的 WebSocket 鉴权 Ticket。
package chat

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

const ticketRandomBytes = 32

var (
	ErrTicketInvalid = errors.New("websocket ticket is invalid")
	ErrTicketExpired = errors.New("websocket ticket is expired")
)

type ticketRecord struct {
	userID    uuid.UUID
	chatID    uuid.UUID
	expiresAt time.Time
}

type IssuedTicket struct {
	Value     string
	ExpiresAt time.Time
}

type TicketService struct {
	mu      sync.Mutex
	tickets map[[sha256.Size]byte]ticketRecord
	ttl     time.Duration
	now     func() time.Time
}

func NewTicketService(ttl time.Duration) *TicketService {
	return &TicketService{
		tickets: make(map[[sha256.Size]byte]ticketRecord),
		ttl:     ttl,
		now: func() time.Time {
			return time.Now().UTC()
		},
	}
}

func (s *TicketService) Issue(
	userID uuid.UUID,
	chatID uuid.UUID,
) (*IssuedTicket, error) {
	randomBytes := make([]byte, ticketRandomBytes)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, err
	}

	value := base64.RawURLEncoding.EncodeToString(randomBytes)
	hash := sha256.Sum256([]byte(value))
	now := s.now()
	expiresAt := now.Add(s.ttl)

	s.mu.Lock()
	s.deleteExpiredLocked(now)
	s.tickets[hash] = ticketRecord{
		userID:    userID,
		chatID:    chatID,
		expiresAt: expiresAt,
	}
	s.mu.Unlock()

	return &IssuedTicket{
		Value:     value,
		ExpiresAt: expiresAt,
	}, nil
}

// Consume 成功或失败后都会删除已经命中的 Ticket，保证它只能尝试使用一次。
func (s *TicketService) Consume(
	value string,
	chatID uuid.UUID,
) (uuid.UUID, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != ticketRandomBytes {
		return uuid.Nil, ErrTicketInvalid
	}

	hash := sha256.Sum256([]byte(value))
	now := s.now()

	s.mu.Lock()
	record, exists := s.tickets[hash]
	if exists {
		delete(s.tickets, hash)
	}
	s.deleteExpiredLocked(now)
	s.mu.Unlock()

	if !exists || record.chatID != chatID {
		return uuid.Nil, ErrTicketInvalid
	}
	if !now.Before(record.expiresAt) {
		return uuid.Nil, ErrTicketExpired
	}
	return record.userID, nil
}

// deleteExpiredLocked 要求调用方已经持有 s.mu。
func (s *TicketService) deleteExpiredLocked(now time.Time) {
	for hash, record := range s.tickets {
		if !now.Before(record.expiresAt) {
			delete(s.tickets, hash)
		}
	}
}
