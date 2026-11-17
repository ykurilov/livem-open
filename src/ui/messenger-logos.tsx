import { useId } from "react";

type Messenger = "telegram" | "vk" | "max";

/**
 * Знак мессенджера вектором, без внешних ссылок: кнопки перехода из веб-чата и «Проверки». Знак — картинка без
 * подписи для чтения с экрана: название мессенджера стоит рядом текстом.
 */
export function MessengerLogo({ channel, size = 32, className }: { channel: Messenger; size?: number; className?: string }) {
  const props = { width: size, height: size, viewBox: "0 0 48 48", "aria-hidden": true, focusable: false, className } as const;
  if (channel === "telegram")
    return (
      <svg {...props}>
        <circle cx="24" cy="24" r="24" fill="#2AABEE" />
        <path
          fill="#fff"
          d="M10.9 23.4c7-3 11.6-5 13.9-6 6.6-2.7 8-3.2 8.9-3.2.2 0 .6 0 .9.3.2.2.3.4.3.6v.9c-.4 4.1-2 13.9-2.9 18.4-.4 1.9-1 2.6-1.7 2.6-1.5.1-2.6-1-4-1.9-2.2-1.5-3.5-2.4-5.7-3.8-2.5-1.7-.9-2.6.5-4.1.4-.4 6.8-6.3 7-6.8 0-.1 0-.3-.1-.4-.2-.1-.4-.1-.5 0-.2.1-3.8 2.4-10.7 7.1-1 .7-1.9 1-2.8 1-.9 0-2.6-.5-3.9-.9-1.6-.5-2.8-.8-2.7-1.7.1-.5.7-.9 1.9-1.4z"
        />
      </svg>
    );
  if (channel === "vk")
    return (
      <svg {...props}>
        <rect width="48" height="48" rx="14" fill="#0077FF" />
        <path
          fill="#fff"
          d="M25.5 34.6c-10.9 0-17.2-7.5-17.4-20h5.5c.2 9.2 4.2 13 7.4 13.8V14.6h5.2v7.9c3.2-.3 6.5-3.9 7.6-7.9H39c-.9 4.9-4.5 8.5-7 10 2.6 1.2 6.7 4.3 8.2 10h-5.7c-1.2-3.8-4.3-6.7-8.3-7.1v7.1h-.7z"
        />
      </svg>
    );
  return <MaxLogo {...props} />;
}

/** Знак MAX: градиентный квадрат и белое облачко-кольцо с хвостиком. */
function MaxLogo(props: React.SVGProps<SVGSVGElement>) {
  const gradient = `max-${useId()}`;
  return (
    <svg {...props}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3FB5FF" />
          <stop offset="0.55" stopColor="#5B5BFF" />
          <stop offset="1" stopColor="#A63DFF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#${gradient})`} />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M24.4 10.5c-7.6 0-13.4 5.6-13.4 13.2 0 2.4.6 4.6 1.6 6.5l-1.5 6.5c-.2.8.6 1.5 1.3 1.2l5.7-2.4c1.9 1 4 1.5 6.3 1.5 7.6 0 13.6-5.7 13.6-13.3S32 10.5 24.4 10.5zm0 5.3c-4.5 0-8 3.5-8 7.9s3.5 7.9 8 7.9 8-3.5 8-7.9-3.5-7.9-8-7.9z"
      />
    </svg>
  );
}
