// @flow
/**
 * Horizons: subscriptions are gone. This provider is a pure passthrough —
 * the context keeps its (no-op) default value so every consumer keeps
 * compiling, but no plan is ever fetched and no checkout dialog can open.
 */
import * as React from 'react';
import {
  type SubscriptionDialogDisplayReason,
  type SubscriptionPlacementId,
} from '../../Utils/Analytics/EventSender';
import {
  type SubscriptionPlanWithPricingSystems,
  type SubscriptionPlan,
} from '../../Utils/GDevelopServices/Usage';

export type SubscriptionType = 'individual' | 'team' | 'education';

export type SubscriptionAnalyticsMetadata = {|
  reason: SubscriptionDialogDisplayReason,
  recommendedPlanId?: string,
  placementId: SubscriptionPlacementId,
  preStep?: 'subscriptionChecker',
|};

type SubscriptionState = {|
  /**
   * Returns subscription plans with pricing systems, or null if not yet fetched.
   * Calling this function will trigger a fetch in the background if not already loaded.
   */
  getSubscriptionPlansWithPricingSystems: () =>
    | SubscriptionPlanWithPricingSystems[]
    | null,
  /**
   * Returns subscription plan of the user, even if it's a legacy plan, or null if not found or no subscription.
   */
  getUserSubscriptionPlanEvenIfLegacy: () => SubscriptionPlanWithPricingSystems | null,
  /**
   * Call this when a subscription or subscription upgrade is required.
   */
  openSubscriptionDialog: ({|
    analyticsMetadata: SubscriptionAnalyticsMetadata,
    couponCode?: string,
  |}) => void,
  /**
   * Returns the current coupon code being used, or null.
   */
  getCouponCode: () => ?string,
  /**
   * Clears the current coupon code.
   */
  clearCouponCode: () => void,
  openRedeemCodeDialog: (options?: {|
    codeToPrefill?: string,
    autoSubmit?: boolean,
  |}) => void,
|};

const noopSubscriptionState: SubscriptionState = {
  getSubscriptionPlansWithPricingSystems: () => null,
  getUserSubscriptionPlanEvenIfLegacy: () => null,
  openSubscriptionDialog: () => {},
  getCouponCode: () => null,
  clearCouponCode: () => {},
  openRedeemCodeDialog: () => {},
};

export const SubscriptionContext: React.Context<SubscriptionState> = React.createContext<SubscriptionState>(
  noopSubscriptionState
);

type SubscriptionProviderProps = {|
  children: React.Node,
  simulateMobileApp?: true,
|};

export const SubscriptionProvider = ({
  children,
  simulateMobileApp,
}: SubscriptionProviderProps): React.MixedElement => {
  return (
    <SubscriptionContext.Provider value={noopSubscriptionState}>
      {children}
    </SubscriptionContext.Provider>
  );
};
