import { createBrowserRouter, Navigate } from 'react-router-dom';

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
    path: routePaths.chat,
    errorElement: <NotFound />,
    children: [
      {
        index: true,
        element: <Chat />,
      },
      {
        path: ':conversationId',
        element: <Chat />,
      },
    ],
  },
  {
    path: routePaths.repository,
    element: <Repository />,
    errorElement: <NotFound />,
  },
  {
    path: '*',
    element: <NotFound />,
  },
]);
