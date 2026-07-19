export const routePaths = {
  root: '/',
  chat: '/chat',
  conversation: '/chat/:conversationId',
  repository: '/repository',
} as const;

export function createConversationPath(conversationId: string = crypto.randomUUID()) {
  return `${routePaths.chat}/${encodeURIComponent(conversationId)}`;
}
