package config

import "testing"

func TestOSSConfiguration(t *testing.T) {
	valid := OSSConfig{Bucket: "test-bucket", Region: "cn-beijing", Endpoint: "https://oss-cn-beijing.aliyuncs.com", AccessKeyID: "test", AccessKeySecret: "secret"}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		change func(*OSSConfig)
	}{
		{"partial credentials", func(c *OSSConfig) { c.AccessKeySecret = "" }},
		{"wrong region", func(c *OSSConfig) { c.Region = "cn-hangzhou" }},
		{"non OSS host", func(c *OSSConfig) { c.Endpoint = "https://example.com" }},
		{"bucket domain as endpoint", func(c *OSSConfig) { c.Endpoint = "https://test-bucket.oss-cn-beijing.aliyuncs.com" }},
		{"unsafe bucket", func(c *OSSConfig) { c.Bucket = "../bad" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := valid
			test.change(&cfg)
			if cfg.Validate() == nil {
				t.Fatal("expected invalid config")
			}
		})
	}
	valid.AccessKeyID, valid.AccessKeySecret = "", ""
	if valid.Enabled() || valid.Validate() != nil {
		t.Fatal("empty credentials should disable uploads without blocking startup")
	}
}
