import { Activity, Database, Gauge, Users } from 'lucide-react';
import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router';
import { PageLoader } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

const LINKS = [
  { to: '/admin/sources', label: 'Data sources', icon: Database },
  { to: '/admin/access', label: 'Users & access', icon: Users },
  { to: '/admin/cache', label: 'Cache', icon: Gauge },
  { to: '/admin/usage', label: 'Usage', icon: Activity },
];

export function AdminLayout() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <nav aria-label="Administration" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              cn(
                '-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-fg-secondary hover:text-fg',
                isActive && 'border-primary text-fg',
              )
            }
          >
            <link.icon className="size-4" aria-hidden="true" />
            {link.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
