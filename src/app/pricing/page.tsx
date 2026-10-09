import { isBillingCheckoutEnabled } from "@/lib/billing-release";
import PricingView from "./pricing-view";

// The release control is resolved on the server; the client view only gets the boolean.
export default function PricingPage() {
  return <PricingView checkoutEnabled={isBillingCheckoutEnabled()} />;
}
