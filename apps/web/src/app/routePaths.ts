export const routePaths = {
  root: '/',
  chat: '/chat',
  repository: '/repository',
  chatDetail: '/chat/:chatId',
} as const;

export function createChatDetailPath(chatId: string) {
  return `${routePaths.chat}/${encodeURIComponent(chatId)}`;
}