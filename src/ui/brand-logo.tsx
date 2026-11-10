import { useId } from "react";

/** Знак «Живых лидмагнитов»: облачко разговора с пульсом. Цвет задаёт .brand-logo в globals.css под тему. */
export function BrandLogo({ size = 24 }: { size?: number }) {
  // Знак стоит и в боковой панели, и в шапке телефона: у каждой копии своя маска
  const maskId = useId();
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <mask id={maskId}>
        <rect width="1024" height="1024" fill="#fff" />
        <polyline points="190,420 340,420 410,250 530,610 610,330 670,420 834,420" fill="none" stroke="#000"
          strokeWidth="90" strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <g fill="currentColor" mask={`url(#${maskId})`}>
        <rect x="40" y="90" width="944" height="660" rx="230" />
        <path d="M200 680 L120 980 L480 730 Z" />
      </g>
    </svg>
  );
}
