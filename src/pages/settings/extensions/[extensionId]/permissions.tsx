import SettingsExtension from '@app/components/Settings/SettingsExtension';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsExtensionPermissionsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsExtension tab="permissions" />
    </SettingsLayout>
  );
};

export default SettingsExtensionPermissionsPage;
