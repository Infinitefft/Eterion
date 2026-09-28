package knowledge

import (
	"bytes"
	"context"
	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"io"
	"time"
)

type FileStore interface {
	Put(context.Context, string, string, []byte) error
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

func (s *OSSStore) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(key)})
	return err
}

func (s *OSSStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	result, err := s.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(key)})
	if err != nil {
		return nil, err
	}
	return result.Body, nil
}

type OSSStore struct {
	bucket string
	client *oss.Client
}

func NewOSSStore(cfg config.OSSConfig) *OSSStore {
	client := oss.NewClient(oss.LoadDefaultConfig().WithRegion(cfg.Region).WithEndpoint(cfg.Endpoint).
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.AccessKeySecret)).
		WithConnectTimeout(5 * time.Second).WithReadWriteTimeout(90 * time.Second).WithRetryMaxAttempts(1))
	return &OSSStore{bucket: cfg.Bucket, client: client}
}
func (s *OSSStore) Put(ctx context.Context, key, mimeType string, data []byte) error {
	_, err := s.client.PutObject(ctx, &oss.PutObjectRequest{
		Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(key), ContentType: oss.Ptr(mimeType),
		Body: bytes.NewReader(data), ContentLength: oss.Ptr(int64(len(data))),
	})
	return err
}
