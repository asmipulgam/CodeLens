import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 animate-fade-in rounded-lg border border-line bg-raised p-1 text-sm text-fg shadow-lg',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none [&_svg]:size-4',
        'data-[disabled]:pointer-events-none data-[highlighted]:bg-wash data-[disabled]:opacity-50',
        destructive && 'text-danger',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn('px-2 py-1.5 text-xs font-medium text-fg-secondary', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('my-1 h-px bg-line', className)} {...props} />;
}
