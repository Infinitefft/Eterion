package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/google/uuid"
)

// IngestFile 复用服务连接；原文来自已通过 Go 校验并保存的上传文件。
func (r *Runner) IngestFile(ctx context.Context, fileID uuid.UUID, format, text string, monitoring ...agent.IngestionMonitoring) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	// 监控采集：旧调用可省略元信息；记录失败不影响业务执行。
	var details *agent.IngestionMonitoring
	if len(monitoring) > 0 {
		details = &monitoring[0]
	}
	body, err := json.Marshal(struct {
		FileID string `json:"fileId"`
		Format string `json:"format"`
		Text   string `json:"text"`
		// 监控采集：身份与文件信息来自 Go 已校验的业务上下文；记录失败不影响业务执行。
		Monitoring *agent.IngestionMonitoring `json:"monitoring,omitempty"`
	}{FileID: fileID.String(), Format: format, Text: text, Monitoring: details})
	if err != nil {
		return errors.New("invalid ingestion input")
	}
	request, err := r.newRequest(ctx, http.MethodPost, "/rag/ingest", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return errors.New("Agent ingestion request failed or outcome unknown")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("Agent ingestion failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return errors.New("invalid ingestion response size")
	}
	var result struct {
		FileID     string `json:"fileId"`
		ChunkCount *int   `json:"chunkCount"`
	}
	if json.Unmarshal(raw, &result) != nil || result.FileID != fileID.String() || result.ChunkCount == nil || *result.ChunkCount < 0 {
		return errors.New("invalid ingestion response")
	}
	return nil
}
