package auth

type RegisterRequest struct {
	Phone    string `json:"phone" validate:"required,phone"`
	Nickname string `json:"nickname" validate:"required,nickname"`
	Password string `json:"password" validate:"required,password"`
}

type LoginRequest struct {
	Phone    string `json:"phone" validate:"required,phone"`
	Password string `json:"password" validate:"required,password"`
}

type UserResponse struct {
	ID       string `json:"id"`
	Phone    string `json:"phone"`
	Nickname string `json:"nickname"`
}

type AuthResponse struct {
	AccessToken string       `json:"access_token"`
	TokenType   string       `json:"token_type"`
	ExpiresIn   int64        `json:"expires_in"`
	User        UserResponse `json:"user"`
}
