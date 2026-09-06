import primaryLogo from "../assets/brand/echo-insight-logo-primary.svg";
import appIcon from "../assets/brand/echo-insight-logo-1024.png";

interface BrandMarkProps {
  size?: number;
  appIconVariant?: boolean;
}

export function BrandMark({ size = 40, appIconVariant = false }: BrandMarkProps) {
  return (
    <img
      alt="Echo Insight"
      className={appIconVariant ? "brand-mark brand-mark--app-icon" : "brand-mark"}
      height={size}
      src={appIconVariant ? appIcon : primaryLogo}
      width={size}
    />
  );
}
