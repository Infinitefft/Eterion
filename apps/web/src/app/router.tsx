import { createBrowserRouter, Navigate } from 'react-router-dom';

import { WorkspaceLayout } from '@/app/layouts/WorkspaceLayout/WorkspaceLayout';
import { routePaths } from '@/app/routePaths';
import { Chat } from '@/pages/Chat/Chat';
import { NotFound } from '@/pages/NotFound/NotFound';
import { Repository } from '@/pages/Repository/Repository';
import { ChatDetail } from '@/pages/ChatDetail/ChatDetail';

export const router = createBrowserRouter([
  {
    path: routePaths.root,
    element: <Navigate to={routePaths.chat} replace />,
  },
  {
    element: <WorkspaceLayout />,
    errorElement: <NotFound />,
    children: [
      {
        path: routePaths.chat,
        element: <Chat />,
      },
      {
        path: routePaths.chatDetail,
        element: <ChatDetail />,
      },
      {
        path: routePaths.repository,
        element: <Repository />,
      },
    ],
  },
  {
    path: '*',
    element: <NotFound />,
  },
]);
