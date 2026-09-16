"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurrentUser = void 0;
const common_1 = require("@nestjs/common");
const auth_constants_1 = require("../auth.constants");
exports.CurrentUser = (0, common_1.createParamDecorator)((_data, ctx) => {
    const request = ctx.switchToHttp().getRequest();
    return request[auth_constants_1.REQUEST_USER_KEY];
});
//# sourceMappingURL=current-user.decorator.js.map