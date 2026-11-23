import { randomBytes } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

export async function attachSignupReferral(connection: PoolConnection, userId: string, referralCode: string, referralClickId: string) {
  if (referralCode) {
    const [affiliateRows] = await connection.execute<Array<RowDataPacket & { user_id: string }>>(
      `SELECT ap.user_id FROM affiliate_profiles ap JOIN users au ON au.id = ap.user_id WHERE ap.referral_code = ? AND ap.status = 'active' AND au.account_role = 'affiliate' AND au.status = 'active' LIMIT 1`, [referralCode],
    );
    if (affiliateRows[0] && affiliateRows[0].user_id !== userId) {
      // Legacy direct /login?ref= links are still supported. When no click
      // record exists, create a first-party Click ID at signup time.
      let attributedClickId = referralClickId || `clk_${randomBytes(18).toString('hex')}`;
      const [clickRows] = await connection.execute<Array<RowDataPacket & { id: number; referred_user_id: string | null }>>(
        `SELECT id, referred_user_id FROM affiliate_clicks
          WHERE affiliate_user_id = ? AND referral_code = ? AND click_id = ?
          LIMIT 1 FOR UPDATE`,
        [affiliateRows[0].user_id, referralCode, attributedClickId],
      );
      const existingClick = clickRows[0];
      if (existingClick?.referred_user_id && existingClick.referred_user_id !== userId) {
        // Never attach one partner click to two customers. If a partner
        // reuses a click ID, create a unique first-party ID for this signup.
        attributedClickId = `clk_${randomBytes(18).toString('hex')}`;
        await connection.execute(
          `INSERT INTO affiliate_clicks
             (affiliate_user_id, referral_code, click_id, click_source, landing_path, referred_user_id, created_at)
           VALUES (?, ?, ?, 'sportrz', '/login', ?, UTC_TIMESTAMP())`,
          [affiliateRows[0].user_id, referralCode, attributedClickId, userId],
        );
      } else if (existingClick) {
        await connection.execute(
          `UPDATE affiliate_clicks SET referred_user_id = COALESCE(referred_user_id, ?)
            WHERE id = ? AND (referred_user_id IS NULL OR referred_user_id = ?)`,
          [userId, existingClick.id, userId],
        );
      } else {
        await connection.execute(
          `INSERT INTO affiliate_clicks
             (affiliate_user_id, referral_code, click_id, click_source, landing_path, referred_user_id, created_at)
           VALUES (?, ?, ?, 'sportrz', '/login', ?, UTC_TIMESTAMP())`,
          [affiliateRows[0].user_id, referralCode, attributedClickId, userId],
        );
      }
      await connection.execute(
        `INSERT IGNORE INTO affiliate_referrals
           (affiliate_user_id, referred_user_id, referral_code, click_id, source, status, created_at)
         VALUES (?, ?, ?, ?, 'link', 'qualified', UTC_TIMESTAMP())`,
        [affiliateRows[0].user_id, userId, referralCode, attributedClickId],
      );
    }
  }
}
