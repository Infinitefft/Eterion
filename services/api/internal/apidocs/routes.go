package apidocs

import (
	"net/http"
	"strings"

	embeddeddocs "github.com/Infinitefft/Eterion/services/api/docs"
	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
)

func RegisterRoutes(engine *gin.Engine, appEnv string) {
	if strings.EqualFold(appEnv, "production") {
		return
	}

	engine.GET("/openapi.yaml", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", embeddeddocs.OpenAPISpec())
	})
	engine.GET("/docs", func(c *gin.Context) {
		c.Redirect(http.StatusTemporaryRedirect, "/docs/index.html")
	})
	engine.GET("/docs/*any", ginSwagger.WrapHandler(
		swaggerFiles.Handler,
		ginSwagger.URL("/openapi.yaml"),
		ginSwagger.DeepLinking(true),
		ginSwagger.DocExpansion("list"),
		ginSwagger.PersistAuthorization(false),
	))
}
