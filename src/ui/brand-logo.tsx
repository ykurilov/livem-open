/** Знак «Живых лидмагнитов»: магнит из трёх кусочков — дуга и два полюса с просветом. Цвета одни для обеих тем. */
export function BrandLogo({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 1024 1024" fill="none" strokeWidth="190" aria-hidden="true">
      <path d="M247 430 V520 A265 265 0 0 0 777 520 V430" stroke="#1C89BF" />
      <path d="M247 120 V300" stroke="#15B392" />
      <path d="M777 120 V300" stroke="#225EE3" />
    </svg>
  );
}
