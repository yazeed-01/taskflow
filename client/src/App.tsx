import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { getToken } from './lib/auth';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { WorkspaceLayout } from './pages/WorkspaceLayout';
import { BoardPage } from './pages/BoardPage';
import { SearchPage } from './pages/SearchPage';
import { ActivityPage } from './pages/ActivityPage';
import { MembersPage } from './pages/MembersPage';
import { useWorkspace } from './lib/workspaceContext';

// Route-level gate only. It improves UX (no flash of a broken page); the *security* boundary is the
// server, which rejects every request without a valid token.
function RequireAuth({ children }: { children: ReactNode }) {
  return getToken() ? <>{children}</> : <Navigate to="/login" replace />;
}

function WorkspaceIndex() {
  const { workspace } = useWorkspace();
  const { slug } = useParams();
  const first = workspace.projects[0];
  if (first) return <Navigate to={`/w/${slug}/p/${first.id}`} replace />;
  return (
    <div className="center">
      <h2>No projects yet</h2>
      <p className="muted">{workspace.viewerRole === 'MEMBER' ? 'Ask an admin to create one.' : 'Create one from the sidebar.'}</p>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/w/:slug" element={<RequireAuth><WorkspaceLayout /></RequireAuth>}>
        <Route index element={<WorkspaceIndex />} />
        <Route path="p/:projectId" element={<BoardPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="members" element={<MembersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
