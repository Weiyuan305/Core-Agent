import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function IconFrame({ children, ...props }: IconProps & { readonly children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75">
        {children}
      </g>
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M12 19V5m0 0-5 5m5-5 5 5" /></IconFrame>;
}

export function BackIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m15 18-6-6 6-6" /></IconFrame>;
}

export function CloseIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m7 7 10 10M17 7 7 17" /></IconFrame>;
}

export function ConversationIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5.5 18.5 6.2 16A7.5 7.5 0 1 1 9 18.2c-1.2.5-2.4.6-3.5.3Z" />
      <path d="M9 11.5h.01m3-.01h.01m3-.01h.01" />
    </IconFrame>
  );
}

export function InspectorIcon(props: IconProps) {
  return <IconFrame {...props}><rect height="15" rx="2" width="18" x="3" y="4.5" /><path d="M15 5v14" /></IconFrame>;
}

export function PlusIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M12 5v14M5 12h14" /></IconFrame>;
}

export function RestartIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M19 8V4m0 0h-4m4 0-3 3a7 7 0 1 0 1.2 8.3" />
    </IconFrame>
  );
}
