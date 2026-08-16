package apidocs

import (
	"bytes"
	_ "embed"
)

//go:embed openapi.yaml
var openAPISpec []byte

func OpenAPISpec() []byte {
	return bytes.Clone(openAPISpec)
}
