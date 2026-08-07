/**
 * The host components published to extension panels as `@constructorfleet/extension-ui`.
 *
 * Panels are pre-built bundles, so the host's Tailwind build never sees their
 * class names and emits no CSS for them — a panel writing its own `className`
 * gets classes that do not exist and renders unstyled, silently. These
 * components' classes *are* compiled, because they live under `src/components/**`
 * where `tailwind.config.js` looks. Re-exporting them is therefore the one way
 * to give panels the app's visual language without a copy of it that can drift.
 *
 * This module only collects them. `src/utils/extensionSharedModules.ts` puts the
 * object on `window.__seerr_shared__`, and the shim from
 * `server/routes/extensionShared.ts` is what a panel's bare import resolves to.
 *
 * Which names exist is decided by `UI_COMPONENT_NAMES` on the server, not here —
 * the shim generator needs the list at process start and cannot import from
 * `src/`. Typing the object as a total `Record` over that union is what keeps the
 * two in step: a name added there without a component here fails to compile,
 * rather than handing a panel `undefined` and crashing it on render.
 */
import type { UiComponentName } from '@server/lib/extensions/uiComponents';
import type { ComponentType } from 'react';

/**
 * The prop a panel component receives, published so a panel can `import type
 * { ExtensionPanelSdk }` instead of restating it.
 *
 * Both examples currently hand-declare a partial `PanelSdk` interface, on the
 * reasoning that the host's type is "small enough that structural agreement is
 * cheaper than shipping the host's `.d.ts`". That was true before this package
 * existed — it now ships exactly that `.d.ts`, generated, so the copies are pure
 * drift surface. A member the host adds is invisible to a panel that restated the
 * type; one the host renames breaks at runtime rather than at build.
 */
export type { ExtensionPanelSdk } from '@app/components/ExtensionPanel/sdk';

import Accordion from '@app/components/Common/Accordion';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Dropdown from '@app/components/Common/Dropdown';
import Header from '@app/components/Common/Header';
import ImageFader from '@app/components/Common/ImageFader';
import LabeledCheckbox from '@app/components/Common/LabeledCheckbox';
import List from '@app/components/Common/List';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import PageTitle from '@app/components/Common/PageTitle';
import PlayButton from '@app/components/Common/PlayButton';
import ProgressCircle from '@app/components/Common/ProgressCircle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import SlideOver from '@app/components/Common/SlideOver';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Table from '@app/components/Common/Table';
import Tabs from '@app/components/Common/Tabs';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';

export {
  Accordion,
  Alert,
  Badge,
  Button,
  ButtonWithDropdown,
  CachedImage,
  ConfirmButton,
  Dropdown,
  Header,
  ImageFader,
  LabeledCheckbox,
  List,
  LoadingSpinner,
  Modal,
  MultiRangeSlider,
  PageTitle,
  PlayButton,
  ProgressCircle,
  SensitiveInput,
  SlideCheckbox,
  SlideOver,
  StatusBadgeMini,
  Table,
  Tabs,
  Tag,
  Tooltip,
};

/**
 * The same components as one object, which is what actually crosses to a panel:
 * `extensionSharedModules.ts` publishes this on the shared global and the shim
 * reads component names off it.
 *
 * The named re-exports above are what give the *package* real prop types — its
 * declarations are generated from this module, and a map alone would emit
 * `ComponentType<any>` for everything. So both forms are needed: the names for
 * types, the object for the runtime handoff.
 *
 * `Record<UiComponentName, …>` makes it total over the server's list, which is
 * the drift guard described in the header. `any` in the value type is deliberate
 * and harmless — these props are unrelated to each other, nothing consumes this
 * object's value type, and authors get the real types from the named exports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const uiComponents: Record<UiComponentName, ComponentType<any>> = {
  Accordion,
  Alert,
  Badge,
  Button,
  ButtonWithDropdown,
  CachedImage,
  ConfirmButton,
  Dropdown,
  Header,
  ImageFader,
  LabeledCheckbox,
  List,
  LoadingSpinner,
  Modal,
  MultiRangeSlider,
  PageTitle,
  PlayButton,
  ProgressCircle,
  SensitiveInput,
  SlideCheckbox,
  SlideOver,
  StatusBadgeMini,
  Table,
  Tabs,
  Tag,
  Tooltip,
};

export default uiComponents;
