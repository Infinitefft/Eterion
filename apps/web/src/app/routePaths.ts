export const routePaths = {
  root: '/',
  chat: '/chat',
  conversation: '/chat/:conversationId',
  repository: '/repository',
} as const;

export function createConversationPath(conversationId = crypto.randomUUID()) {
  return `${routePaths.chat}/${encodeURIComponent(conversationId)}`;
}
