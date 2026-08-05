import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsExtensions from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsExtensions';
import type { NextPage } from 'next';

const NotificationsPage: NextPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsExtensions />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
