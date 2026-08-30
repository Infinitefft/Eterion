export const routePaths = {
  root: '/',
  chat: '/chat',
  repository: '/repository',
  chatDetail: '/chat/:threadId',
} as const;

export function createChatDetailPath(threadId: string) {
  return `${routePaths.chat}/${encodeURIComponent(threadId)}`;
}
