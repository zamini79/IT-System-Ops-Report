import { Router } from "express";
import * as controller from "./auth.controller";
import { authGuard } from "./auth.guard";

export const authRouter = Router();

// 인증 불필요
authRouter.post("/login",   controller.login);
authRouter.post("/refresh", controller.refresh);
authRouter.post("/logout",  controller.logout);

// 인증 필요
authRouter.get("/me", authGuard, controller.me);
