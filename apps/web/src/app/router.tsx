import { createBrowserRouter, Navigate } from 'react-router-dom';

import { WorkspaceLayout } from '@/app/layouts/WorkspaceLayout';
import { routePaths } from '@/app/routePaths';
import { Chat } from '@/pages/Chat';
import { NotFound } from '@/pages/NotFound';
import { Repository } from '@/pages/Repository';

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
        path: routePaths.conversation,
        element: <Chat />,
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
