import { Compass } from 'lucide-react';
import { lazy } from 'react';
import { Link, Navigate, Outlet, createBrowserRouter } from 'react-router';
import { AuthProvider } from '@/auth/AuthProvider';
import { LoginPage } from '@/auth/LoginPage';
import { RequireAuth, RequirePermission } from '@/auth/session';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/misc';
import { AskPage } from '@/features/ask/AskPage';
import { AppLayout } from './AppLayout';

// Less-used pages load on demand so the Ask page starts fast.
const CatalogPage = lazy(() => import('@/features/catalog/CatalogPage').then((m) => ({ default: m.CatalogPage })));
const CatalogSourcePage = lazy(() =>
  import('@/features/catalog/CatalogSourcePage').then((m) => ({ default: m.CatalogSourcePage })),
);
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AdminLayout = lazy(() => import('@/features/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const SourcesPage = lazy(() => import('@/features/admin/sources/SourcesPage').then((m) => ({ default: m.SourcesPage })));
const SourceWizardPage = lazy(() =>
  import('@/features/admin/sources/SourceWizard').then((m) => ({ default: m.SourceWizardPage })),
);
const AccessPage = lazy(() => import('@/features/admin/access/AccessPage').then((m) => ({ default: m.AccessPage })));
const CachePage = lazy(() => import('@/features/admin/cache/CachePage').then((m) => ({ default: m.CachePage })));
const UsagePage = lazy(() => import('@/features/admin/usage/UsagePage').then((m) => ({ default: m.UsagePage })));
const AuditPage = lazy(() => import('@/features/audit/AuditPage').then((m) => ({ default: m.AuditPage })));

function NotFound() {
  return (
    <EmptyState
      className="h-full"
      icon={<Compass />}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={
        <Link to="/ask" className={buttonClass({ variant: 'outline' })}>
          Go to Ask
        </Link>
      }
    />
  );
}

function AuthRoot() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <AuthRoot />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Navigate to="/ask" replace /> },
          { path: 'ask', element: <AskPage /> },
          { path: 'ask/:conversationId', element: <AskPage /> },
          { path: 'catalog', element: <CatalogPage /> },
          { path: 'catalog/:sourceId', element: <CatalogSourcePage /> },
          { path: 'settings', element: <SettingsPage /> },
          {
            path: 'admin',
            element: (
              <RequirePermission permission="canAdmin">
                <AdminLayout />
              </RequirePermission>
            ),
            children: [
              { index: true, element: <Navigate to="sources" replace /> },
              { path: 'sources', element: <SourcesPage /> },
              { path: 'sources/new', element: <SourceWizardPage /> },
              { path: 'sources/:sourceId', element: <SourceWizardPage /> },
              { path: 'access', element: <AccessPage /> },
              { path: 'cache', element: <CachePage /> },
              { path: 'usage', element: <UsagePage /> },
            ],
          },
          {
            path: 'audit',
            element: (
              <RequirePermission permission="canAudit">
                <AuditPage />
              </RequirePermission>
            ),
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
