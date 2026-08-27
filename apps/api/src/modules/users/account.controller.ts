import { Controller, Delete } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { AccountService, type DeleteAccountResult } from './account.service.js';

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /**
   * Suppression du compte connecté (règle App Store 5.1.1(v), droit à
   * l'effacement RGPD). Voir la doc de `AccountService.deleteAccount` pour ce
   * qui est effacé, anonymisé, ou conservé.
   */
  @Delete('me')
  @ApiOperation({ summary: 'Delete the signed-in account (GDPR erasure)' })
  deleteMe(@CurrentUser() user: AuthenticatedUser): Promise<DeleteAccountResult> {
    return this.account.deleteAccount(user);
  }
}
