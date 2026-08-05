import SettingsExtensions from '@app/components/Settings/SettingsExtensions';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsExtensionsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsExtensions />
    </SettingsLayout>
  );
};

export default SettingsExtensionsPage;
