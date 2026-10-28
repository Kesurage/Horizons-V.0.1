// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';
import { Column, Line } from '../../UI/Grid';
import { ResponsiveLineStackLayout } from '../../UI/Layout';
import {
  type SubscriptionDialogDisplayReason,
  type SubscriptionPlacementId,
} from '../../Utils/Analytics/EventSender';
import { SubscriptionContext } from './SubscriptionContext';
import RaisedButton from '../../UI/RaisedButton';
import FlatButton from '../../UI/FlatButton';
import Coin from '../../Credits/Icons/Coin';
import classes from './GetSubscriptionCard.module.css';
import Paper from '../../UI/Paper';
import CrownShining from '../../UI/CustomSvgIcons/CrownShining';
import { useResponsiveWindowSize } from '../../UI/Responsive/ResponsiveWindowMeasurer';
import IconButton from '../../UI/IconButton';
import Cross from '../../UI/CustomSvgIcons/Cross';

const styles = {
  topRightHideButton: { position: 'absolute', right: 1, top: 1 },
  paper: {
    zIndex: 2, // Make sure the paper is above the background for the border effect.
    flex: 1,
  },
  diamondIcon: {
    width: 70,
    height: 70,
  },
  coinIcon: {
    width: 12,
    height: 12,
    // Prevent cumulative layout shift by enforcing the ratio.
    aspectRatio: '1',
  },
};

type Props = {|
  children: React.Node,
  subscriptionDialogOpeningReason: SubscriptionDialogDisplayReason,
  label?: React.Node,
  hideButton?: boolean,
  payWithCreditsOptions?: {|
    label: React.Node,
    onPayWithCredits: () => void,
  |},
  onUpgrade?: () => void,
  forceColumnLayout?: boolean,
  filter?: 'individual' | 'team' | 'education',
  recommendedPlanId?:
    | 'gdevelop_silver'
    | 'gdevelop_gold'
    | 'gdevelop_startup'
    | 'gdevelop_education',
  canHide?: boolean,
  placementId: SubscriptionPlacementId,
|};

const GetSubscriptionCard = ({
  children,
  subscriptionDialogOpeningReason,
  label,
  hideButton,
  payWithCreditsOptions,
  onUpgrade,
  forceColumnLayout,
  recommendedPlanId,
  canHide,
  placementId,
}: Props): null | React.MixedElement => {
  // Horizons: subscriptions are gone — this upsell card never renders.
  // The component is kept so every call site keeps compiling.
  return null;
};

export default GetSubscriptionCard;
