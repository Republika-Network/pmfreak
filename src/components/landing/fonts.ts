import { Outfit, Permanent_Marker } from "next/font/google";

// Landing-only type: a chunky geometric display face for headlines and a marker
// hand for the scribbled annotations around the mascot. Exposed as CSS variables
// so the rest of the landing keeps the app's Inter body text.
export const displayFont = Outfit({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-pmf-display",
  display: "swap",
});

export const markerFont = Permanent_Marker({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-pmf-marker",
  display: "swap",
});
