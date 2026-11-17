import {
  BookOpen,
  ChevronDown,
  FlaskConical,
  LogOut,
  Menu,
  MessageSquareText,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { Suspense, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { PageLoader } from '@/components/ui/misc';
import { useAuth } from '@/auth/AuthProvider';
import { IdleTimeout } from '@/auth/IdleTimeout';
import { useSession } from '@/auth/session';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { Logo } from './Logo';
import { useTheme, type ThemeChoice } from './theme';

interface NavItem {
  to: string;
  label: string;
  icon: typeof MessageSquareText;
  show: boolean;
}

export function AppLayout() {
  const { user } = useSession();
  const { logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const nav: NavItem[] = [
    { to: '/ask', label: 'Ask', icon: MessageSquareText, show: true },
    { to: '/catalog', label: 'What can I ask?', icon: BookOpen, show: true },
    { to: '/admin', label: 'Admin', icon: ShieldCheck, show: user.permissions.canAdmin },
    { to: '/audit', label: 'Audit log', icon: ScrollText, show: user.permissions.canAudit },
  ].filter((item) => item.show);

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const themeIcons: Record<ThemeChoice, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

  const navLinks = (onNavigate?: () => void) =>
    nav.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-wash hover:text-fg',
            isActive && 'bg-wash text-fg',
          )
        }
      >
        <item.icon className="size-4" aria-hidden="true" />
        {item.label}
      </NavLink>
    ));

  return (
    <div className="flex h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu />
        </Button>
        <NavLink to="/ask" className="rounded-md" aria-label="CodeLens home">
          <Logo withText />
        </NavLink>
        {env.useMocks && (
          <Badge tone="warning" className="hidden sm:inline-flex">
            <FlaskConical aria-hidden="true" /> Demo data
          </Badge>
        )}
        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
          {navLinks()}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-sm hover:bg-wash"
                aria-label={`Account menu for ${user.name}`}
              >
                <span className="grid size-7 place-items-center rounded-full bg-primary-wash text-xs font-semibold text-fg">
                  {initials}
                </span>
                <span className="hidden max-w-40 truncate font-medium lg:inline">{user.name}</span>
                <ChevronDown className="size-3.5 text-fg-secondary" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>
                <span className="block truncate text-sm font-medium text-fg">{user.name}</span>
                <span className="block truncate">{user.email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <NavLink to="/settings">
                  <Settings /> Settings
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              {(['light', 'dark', 'system'] as const).map((choice) => {
                const Icon = themeIcons[choice];
                return (
                  <DropdownMenuItem key={choice} onSelect={() => setTheme(choice)}>
                    <Icon />
                    <span className="capitalize">{choice}</span>
                    {theme === choice && <span className="ml-auto text-xs text-fg-secondary">Current</span>}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void logout('signed_out')}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent size="sm" className="top-4 translate-y-0 animate-fade-in p-4">
          <DialogTitle className="mb-2 text-base">Navigation</DialogTitle>
          <nav aria-label="Main" className="flex flex-col gap-1">
            {navLinks(() => setMobileNavOpen(false))}
          </nav>
        </DialogContent>
      </Dialog>

      <main id="main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        <ErrorBoundary key={location.pathname.split('/')[1]}>
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <IdleTimeout />
    </div>
  );
}
