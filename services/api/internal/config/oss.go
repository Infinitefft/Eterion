package config

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

type OSSConfig struct {
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	AccessKeySecret string
}

func (c OSSConfig) Enabled() bool { return c.AccessKeyID != "" && c.AccessKeySecret != "" }

func (c OSSConfig) Validate() error {
	// 未配置密钥时仅禁用上传，不影响已有登录和知识库功能。
	if c.AccessKeyID == "" && c.AccessKeySecret == "" {
		return nil
	}
	if !c.Enabled() {
		return errors.New("OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET must both be set")
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`).MatchString(c.Bucket) {
		return errors.New("OSS_BUCKET must be a valid bucket name")
	}
	if !regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)+$`).MatchString(c.Region) {
		return errors.New("OSS_REGION is invalid")
	}
	// 当前仅使用普通公网 Endpoint，避免将凭证发向误填的地址。
	if strings.TrimSuffix(c.Endpoint, "/") != fmt.Sprintf("https://oss-%s.aliyuncs.com", c.Region) {
		return errors.New("OSS_ENDPOINT must be the HTTPS public endpoint matching OSS_REGION")
	}
	return nil
}
