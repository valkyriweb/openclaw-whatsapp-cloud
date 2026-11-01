import { CloudAccountSchema, type CloudAccount } from "../dist/api.js";

// Check the emitted declarations from a consumer's perspective.
const result = CloudAccountSchema.safeParse({});
if (result.success) {
  const account: CloudAccount = result.data;
  void account.phoneNumberId;
} else {
  const issues: readonly { message: string }[] = result.error.issues;
  void issues;
}
