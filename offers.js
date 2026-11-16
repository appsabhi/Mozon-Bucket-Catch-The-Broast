// MOZON — Demo Placeholder Offer Configuration
// Clean, easy to replace when the client confirms the actual offer.
const SOOFI_MANDI_DEMO_OFFERS = [
  {
    id: "offer-main",
    badge: "YOUR BROAST REWARD",
    title: "Complimentary MOZON Broast",
    description: "Enjoy a special broast reward with your dine-in experience.",
    brand: "MOZON · GROUP OF RESTAURANTS",
    instructions: "Show this screen to our staff to claim your reward."
  }
];

if (typeof window !== "undefined") {
  window.SOOFI_MANDI_DEMO_OFFERS = SOOFI_MANDI_DEMO_OFFERS;
  window.SOOfiMandiOffers = SOOFI_MANDI_DEMO_OFFERS;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SOOFI_MANDI_DEMO_OFFERS,
    DEFAULT_OFFER: SOOFI_MANDI_DEMO_OFFERS[0]
  };
}
