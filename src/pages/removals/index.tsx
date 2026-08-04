import RemovalRequestList from '@app/components/RemovalRequestList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@server/lib/permissions';
import type { NextPage } from 'next';

const RemovalRequestsPage: NextPage = () => {
  // REQUEST_REMOVE holders land here to track their own removal requests; the
  // server scopes the rows they can see.
  useRouteGuard(
    [
      Permission.MANAGE_REQUESTS,
      Permission.REQUEST_VIEW,
      Permission.REQUEST_REMOVE,
    ],
    { type: 'or' }
  );
  return <RemovalRequestList />;
};

export default RemovalRequestsPage;
