import type { ExtensionImageKind } from '@app/components/ExtensionPanel/sdk';
import { resolveImageUrl } from '@app/components/ExtensionPanel/sdk';
import useSettings from '@app/hooks/useSettings';
import type { ImageLoader, ImageProps } from 'next/image';
import Image from 'next/image';

const imageLoader: ImageLoader = ({ src }) => src;

export type CachedImageProps = ImageProps & {
  src: string;
  type: ExtensionImageKind;
};

/**
 * The CachedImage component should be used wherever
 * we want to offer the option to locally cache images.
 *
 * The URL rewriting itself lives in `resolveImageUrl`, shared with the extension
 * panel SDK's `imageUrl`: a panel cannot render this component (it needs the
 * host's build), so it gets the rule rather than a second copy of it.
 **/
const CachedImage = ({ src, type, ...props }: CachedImageProps) => {
  const { currentSettings } = useSettings();

  const imageUrl = resolveImageUrl(src, type, currentSettings.cacheImages);

  return <Image unoptimized loader={imageLoader} src={imageUrl} {...props} />;
};

export default CachedImage;
