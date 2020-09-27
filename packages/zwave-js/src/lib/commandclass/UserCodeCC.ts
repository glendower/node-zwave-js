import {
	CommandClasses,
	enumValuesToMetadataStates,
	Maybe,
	MessageOrCCLogEntry,
	parseBitMask,
	unknownBoolean,
	validatePayload,
	ValueID,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName, num2hex, pick } from "@zwave-js/shared";
import {
	CCAPI,
	SetValueImplementation,
	SET_VALUE,
	throwMissingPropertyKey,
	throwUnsupportedProperty,
	throwUnsupportedPropertyKey,
	throwWrongValueType,
} from "../commandclass/API";
import type { Driver } from "../driver/Driver";
import log from "../log";
import { MessagePriority } from "../message/Constants";
import {
	API,
	CCCommand,
	CCCommandOptions,
	ccValue,
	ccValueMetadata,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// All the supported commands
export enum UserCodeCommand {
	Set = 0x01,
	Get = 0x02,
	Report = 0x03,
	// V2+
	UsersNumberGet = 0x04,
	UsersNumberReport = 0x05,
	CapabilitiesGet = 0x06,
	CapabilitiesReport = 0x07,
	KeypadModeSet = 0x08,
	KeypadModeGet = 0x09,
	KeypadModeReport = 0x0a,
	ExtendedUserCodeSet = 0x0b,
	ExtendedUserCodeGet = 0x0c,
	ExtendedUserCodeReport = 0x0d,
	MasterCodeSet = 0x0e,
	MasterCodeGet = 0x0f,
	MasterCodeReport = 0x10,
	UserCodeChecksumGet = 0x11,
	UserCodeChecksumReport = 0x12,
}

// @publicAPI
export enum UserIDStatus {
	Available = 0x00,
	Enabled,
	Disabled,
	Messaging,
	PassageMode,
	StatusNotAvailable = 0xfe,
}

// @publicAPI
export enum KeypadMode {
	Normal = 0x00,
	Vacation,
	Privacy,
	LockedOut,
}

export function getSupportedUsersValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportedUsers",
	};
}

export function getUserIdStatusValueID(
	endpoint: number | undefined,
	userId: number,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "userIdStatus",
		propertyKey: userId,
	};
}

export function getUserCodeValueID(
	endpoint: number | undefined,
	userId: number,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "userCode",
		propertyKey: userId,
	};
}

export function getUserCodeChecksumValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "userCodeChecksum",
	};
}

export function getSupportsMasterCodeValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportsMasterCode",
	};
}

export function getSupportsMasterCodeDeactivationValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportsMasterCodeDeactivation",
	};
}

export function getSupportsUserCodeChecksumValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportsUserCodeChecksum",
	};
}

export function getSupportedUserIDStatusesValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportedUserIDStatuses",
	};
}

export function getSupportedKeypadModesValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportedKeypadModes",
	};
}

export function getKeypadModeValueID(endpoint: number | undefined): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "keypadMode",
	};
}

export function getSupportedASCIICharsValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportedASCIIChars",
	};
}

export function getSupportsMultipleUserCodeSetValueID(
	endpoint: number | undefined,
): ValueID {
	return {
		commandClass: CommandClasses["User Code"],
		endpoint,
		property: "supportsMultipleUserCodeSet",
	};
}

function parseExtendedUserCode(
	payload: Buffer,
): { code: UserCode; bytesRead: number } {
	validatePayload(payload.length >= 4);
	const userId = payload.readUInt16BE(0);
	const status: UserIDStatus = payload[2];
	const codeLength = payload[3] & 0b1111;
	validatePayload(payload.length >= 4 + codeLength);
	const code = payload.slice(4, 4 + codeLength).toString("ascii");
	return {
		code: {
			userId,
			userIdStatus: status,
			userCode: code,
		},
		bytesRead: 4 + codeLength,
	};
}

function validateCode(code: string, supportedChars: string): boolean {
	if (code.length < 4 || code.length > 10) return false;
	return [...code].every((char) => supportedChars.includes(char));
}

function persistUserCode(
	this: UserCodeCC,
	userId: number,
	userIdStatus: UserIDStatus,
	userCode: string,
) {
	const statusValueId = getUserIdStatusValueID(this.endpointIndex, userId);
	const codeValueId = getUserCodeValueID(this.endpointIndex, userId);
	const valueDB = this.getValueDB();
	const supportedUserIDStatuses =
		valueDB.getValue<UserIDStatus[]>(
			getSupportedUserIDStatusesValueID(this.endpointIndex),
		) ??
		(this.version === 1
			? [
					UserIDStatus.Available,
					UserIDStatus.Enabled,
					UserIDStatus.Disabled,
			  ]
			: [
					UserIDStatus.Available,
					UserIDStatus.Enabled,
					UserIDStatus.Disabled,
					UserIDStatus.Messaging,
					UserIDStatus.PassageMode,
			  ]);

	// Check if this code is supported
	if (userIdStatus === UserIDStatus.StatusNotAvailable) {
		// It is not, remove all values if any exist
		valueDB.removeValue(statusValueId);
		valueDB.removeValue(codeValueId);
		valueDB.setMetadata(statusValueId, undefined);
		valueDB.setMetadata(codeValueId, undefined);
	} else {
		// Always create metadata if it does not exist
		if (!valueDB.hasMetadata(statusValueId)) {
			valueDB.setMetadata(statusValueId, {
				...ValueMetadata.Number,
				label: `User ID status (${userId})`,
				states: enumValuesToMetadataStates(
					UserIDStatus,
					supportedUserIDStatuses,
				),
			});
		}
		if (!valueDB.hasMetadata(codeValueId)) {
			valueDB.setMetadata(codeValueId, {
				...ValueMetadata.String,
				minLength: 4,
				maxLength: 10,
				label: `User Code (${userId})`,
			});
		}

		valueDB.setValue(statusValueId, userIdStatus);
		valueDB.setValue(codeValueId, userCode);
	}

	return true;
}

@API(CommandClasses["User Code"])
export class UserCodeCCAPI extends CCAPI {
	public supportsCommand(cmd: UserCodeCommand): Maybe<boolean> {
		switch (cmd) {
			case UserCodeCommand.Get:
			case UserCodeCommand.Set:
			case UserCodeCommand.UsersNumberGet:
				return true; // This is mandatory

			case UserCodeCommand.CapabilitiesGet:
			case UserCodeCommand.KeypadModeSet:
			case UserCodeCommand.KeypadModeGet:
			case UserCodeCommand.ExtendedUserCodeSet:
			case UserCodeCommand.ExtendedUserCodeGet:
				return this.version >= 2;

			case UserCodeCommand.MasterCodeSet:
			case UserCodeCommand.MasterCodeGet: {
				if (this.version < 2) return false;
				const node = this.endpoint.getNodeUnsafe()!;
				const ret =
					node.getValue<Maybe<boolean>>(
						getSupportsMasterCodeValueID(this.endpoint.index),
					) ?? unknownBoolean;
				return ret;
			}

			case UserCodeCommand.UserCodeChecksumGet: {
				if (this.version < 2) return false;
				const node = this.endpoint.getNodeUnsafe()!;
				const ret =
					node.getValue<Maybe<boolean>>(
						getSupportsUserCodeChecksumValueID(this.endpoint.index),
					) ?? unknownBoolean;
				return ret;
			}
		}
		return super.supportsCommand(cmd);
	}

	protected [SET_VALUE]: SetValueImplementation = async (
		{ property, propertyKey },
		value,
	): Promise<void> => {
		if (property === "keypadMode") {
			if (typeof value !== "number") {
				throwWrongValueType(
					this.ccId,
					property,
					"number",
					typeof value,
				);
			}
			await this.setKeypadMode(value);
		} else if (property === "masterCode") {
			if (typeof value !== "string") {
				throwWrongValueType(
					this.ccId,
					property,
					"string",
					typeof value,
				);
			}
			await this.setMasterCode(value);
		} else if (property === "userIdStatus") {
			if (propertyKey == undefined) {
				throwMissingPropertyKey(this.ccId, property);
			} else if (typeof propertyKey !== "number") {
				throwUnsupportedPropertyKey(this.ccId, property, propertyKey);
			}
			if (typeof value !== "number") {
				throwWrongValueType(
					this.ccId,
					property,
					"number",
					typeof value,
				);
			}

			if (value === UserIDStatus.Available) {
				// Clear Code
				await this.clear(propertyKey);
			} else {
				// We need to set the user code along with the status
				const node = this.endpoint.getNodeUnsafe()!;
				const userCode = node.getValue<string>(
					getUserCodeValueID(this.endpoint.index, propertyKey),
				);
				await this.set(propertyKey, value, userCode!);
			}
		} else if (property === "userCode") {
			if (propertyKey == undefined) {
				throwMissingPropertyKey(this.ccId, property);
			} else if (typeof propertyKey !== "number") {
				throwUnsupportedPropertyKey(this.ccId, property, propertyKey);
			}
			if (typeof value !== "string") {
				throwWrongValueType(
					this.ccId,
					property,
					"string",
					typeof value,
				);
			}

			// We need to set the user id status along with the code
			const node = this.endpoint.getNodeUnsafe()!;
			let userIdStatus = node.getValue<UserIDStatus>(
				getUserIdStatusValueID(this.endpoint.index, propertyKey),
			);
			if (
				userIdStatus === UserIDStatus.Available ||
				userIdStatus == undefined
			) {
				userIdStatus = UserIDStatus.Enabled;
			}
			await this.set(propertyKey, userIdStatus as any, value);
		} else {
			throwUnsupportedProperty(this.ccId, property);
		}
	};

	public async getUsersCount(): Promise<number> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.UsersNumberGet,
		);

		const cc = new UserCodeCCUsersNumberGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			UserCodeCCUsersNumberReport
		>(cc, this.commandOptions))!;
		return response.supportedUsers;
	}

	public async get(
		userId: number,
		multiple?: false,
	): Promise<Pick<UserCode, "userIdStatus" | "userCode">>;
	public async get(
		userId: number,
		multiple: true,
	): Promise<{ userCodes: readonly UserCode[]; nextUserId: number }>;
	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async get(userId: number, multiple: boolean = false) {
		if (userId > 255 || multiple) {
			this.assertSupportsCommand(
				UserCodeCommand,
				UserCodeCommand.ExtendedUserCodeGet,
			);

			const cc = new UserCodeCCExtendedUserCodeGet(this.driver, {
				nodeId: this.endpoint.nodeId,
				endpoint: this.endpoint.index,
				userId,
				reportMore: multiple,
			});
			const response = (await this.driver.sendCommand<
				UserCodeCCExtendedUserCodeReport
			>(cc, this.commandOptions))!;
			if (multiple) {
				return pick(response, ["userCodes", "nextUserId"]);
			} else {
				return pick(response.userCodes[0], [
					"userIdStatus",
					"userCode",
				]);
			}
		} else {
			this.assertSupportsCommand(UserCodeCommand, UserCodeCommand.Get);

			const cc = new UserCodeCCGet(this.driver, {
				nodeId: this.endpoint.nodeId,
				endpoint: this.endpoint.index,
				userId,
			});
			const response = (await this.driver.sendCommand<UserCodeCCReport>(
				cc,
				this.commandOptions,
			))!;
			return pick(response, ["userIdStatus", "userCode"]);
		}
	}

	/** Configures a single user code */
	public async set(
		userId: number,
		userIdStatus: Exclude<
			UserIDStatus,
			UserIDStatus.Available | UserIDStatus.StatusNotAvailable
		>,
		userCode: string,
	): Promise<void> {
		if (this.version > 1 || userId > 255) {
			return this.setMany([{ userId, userIdStatus, userCode }]);
		}

		this.assertSupportsCommand(UserCodeCommand, UserCodeCommand.Set);

		const cc = new UserCodeCCSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			userId,
			userIdStatus,
			userCode,
		});

		await this.driver.sendCommand(cc, this.commandOptions);

		// Refresh the current value
		await this.get(userId);
	}

	/** Configures multiple user codes */
	public async setMany(codes: UserCodeCCSetOptions[]): Promise<void> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.ExtendedUserCodeSet,
		);

		const cc = new UserCodeCCExtendedUserCodeSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			userCodes: codes,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	/**
	 * Clears one or all user code
	 * @param userId The user code to clear. If none or 0 is given, all codes are cleared
	 */
	public async clear(userId: number = 0): Promise<void> {
		if (this.version > 1 || userId > 255) {
			await this.setMany([
				{ userId, userIdStatus: UserIDStatus.Available },
			]);
		} else {
			this.assertSupportsCommand(UserCodeCommand, UserCodeCommand.Set);

			const cc = new UserCodeCCSet(this.driver, {
				nodeId: this.endpoint.nodeId,
				endpoint: this.endpoint.index,
				userId,
				userIdStatus: UserIDStatus.Available,
			});
			await this.driver.sendCommand(cc, this.commandOptions);
		}

		// Refresh the current value
		await this.get(userId);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getCapabilities() {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.CapabilitiesGet,
		);

		const cc = new UserCodeCCCapabilitiesGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			UserCodeCCCapabilitiesReport
		>(cc, this.commandOptions))!;
		return pick(response, [
			"supportsMasterCode",
			"supportsMasterCodeDeactivation",
			"supportsUserCodeChecksum",
			"supportsMultipleUserCodeReport",
			"supportsMultipleUserCodeSet",
			"supportedUserIDStatuses",
			"supportedKeypadModes",
			"supportedASCIIChars",
		]);
	}

	public async getKeypadMode(): Promise<KeypadMode> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.KeypadModeGet,
		);

		const cc = new UserCodeCCKeypadModeGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			UserCodeCCKeypadModeReport
		>(cc, this.commandOptions))!;
		return response.keypadMode;
	}

	public async setKeypadMode(keypadMode: KeypadMode): Promise<void> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.KeypadModeSet,
		);

		const cc = new UserCodeCCKeypadModeSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			keypadMode,
		});

		await this.driver.sendCommand(cc, this.commandOptions);

		// Refresh the current value
		await this.getKeypadMode();
	}

	public async getMasterCode(): Promise<string> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.MasterCodeGet,
		);

		const cc = new UserCodeCCMasterCodeGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			UserCodeCCMasterCodeReport
		>(cc, this.commandOptions))!;
		return response.masterCode;
	}

	public async setMasterCode(masterCode: string): Promise<void> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.MasterCodeSet,
		);

		const cc = new UserCodeCCMasterCodeSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			masterCode,
		});

		await this.driver.sendCommand(cc, this.commandOptions);

		// Refresh the current value
		await this.getMasterCode();
	}

	public async getUserCodeChecksum(): Promise<number> {
		this.assertSupportsCommand(
			UserCodeCommand,
			UserCodeCommand.UserCodeChecksumGet,
		);

		const cc = new UserCodeCCUserCodeChecksumGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			UserCodeCCUserCodeChecksumReport
		>(cc, this.commandOptions))!;
		return response.userCodeChecksum;
	}
}

@commandClass(CommandClasses["User Code"])
@implementedVersion(2)
export class UserCodeCC extends CommandClass {
	declare ccCommand: UserCodeCommand;

	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const endpoint = this.getEndpoint()!;
		const api = endpoint.commandClasses["User Code"].withOptions({
			priority: MessagePriority.NodeQuery,
		});

		log.controller.logNode(node.id, {
			message: `${this.constructor.name}: doing a ${
				complete ? "complete" : "partial"
			} interview...`,
			direction: "none",
		});

		// Query capabilities first because they determine the next steps
		let supportsMasterCode: boolean;
		let supportsUserCodeChecksum: boolean;
		let supportedKeypadModes: readonly KeypadMode[];
		let supportedUsers: number;
		if (complete) {
			log.controller.logNode(node.id, {
				message: "querying capabilities...",
				direction: "outbound",
			});
			({
				supportsMasterCode,
				supportsUserCodeChecksum,
				supportedKeypadModes,
			} = await api.getCapabilities());

			log.controller.logNode(node.id, {
				message: "querying number of user codes...",
				direction: "outbound",
			});
			supportedUsers = await api.getUsersCount();
		} else {
			supportsMasterCode =
				node.getValue<boolean>(
					getSupportsMasterCodeValueID(this.endpointIndex),
				) ?? false;
			supportsUserCodeChecksum =
				node.getValue<boolean>(
					getSupportsUserCodeChecksumValueID(this.endpointIndex),
				) ?? false;
			supportedKeypadModes =
				node.getValue<readonly KeypadMode[]>(
					getSupportedKeypadModesValueID(this.endpointIndex),
				) ?? [];
			supportedUsers =
				node.getValue<number>(
					getSupportedUsersValueID(this.endpointIndex),
				) ?? 0;
		}

		// Now check for changed values and codes
		if (this.version >= 2) {
			if (supportsMasterCode) {
				log.controller.logNode(node.id, {
					message: "querying master code...",
					direction: "outbound",
				});
				await api.getMasterCode();
			}
			if (supportedKeypadModes.length > 1) {
				log.controller.logNode(node.id, {
					message: "querying active keypad mode...",
					direction: "outbound",
				});
				await api.getKeypadMode();
			}
			const storedUserCodeChecksum =
				node.getValue<number>(
					getUserCodeChecksumValueID(this.endpointIndex),
				) ?? 0;
			let currentUserCodeChecksum = 0;
			if (supportsUserCodeChecksum) {
				log.controller.logNode(node.id, {
					message: "retrieving current user code checksum...",
					direction: "outbound",
				});
				currentUserCodeChecksum = await api.getUserCodeChecksum();
			}
			if (
				!supportsUserCodeChecksum ||
				currentUserCodeChecksum !== storedUserCodeChecksum
			) {
				log.controller.logNode(node.id, {
					message:
						"checksum changed or is not supported, querying all user codes...",
					direction: "outbound",
				});
				let nextUserId = 1;
				while (nextUserId > 0 && nextUserId <= supportedUsers) {
					({ nextUserId } = await api.get(nextUserId, true));
				}
			}
		} else {
			// V1
			log.controller.logNode(node.id, {
				message: "querying all user codes...",
				direction: "outbound",
			});
			for (let userId = 1; userId <= supportedUsers; userId++) {
				await api.get(userId);
			}
		}

		// Remember that the interview is complete
		this.interviewComplete = true;
	}
}

type UserCodeCCSetOptions =
	| {
			userId: 0;
			userIdStatus: UserIDStatus.Available;
			userCode?: undefined;
	  }
	| {
			userId: number;
			userIdStatus: UserIDStatus.Available;
			userCode?: undefined;
	  }
	| {
			userId: number;
			userIdStatus: Exclude<
				UserIDStatus,
				UserIDStatus.Available | UserIDStatus.StatusNotAvailable
			>;
			userCode: string;
	  };

@CCCommand(UserCodeCommand.Set)
export class UserCodeCCSet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| (CCCommandOptions & UserCodeCCSetOptions),
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			const numUsers =
				this.getNode()?.getValue<number>(
					getSupportedUsersValueID(this.endpointIndex),
				) ?? 0;
			this.userId = options.userId;
			this.userIdStatus = options.userIdStatus;

			// Validate options
			if (this.userId < 0 || this.userId > numUsers) {
				throw new ZWaveError(
					`${this.constructor.name}: The user ID must be between 0 and the number of supported users ${numUsers}.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			} else if (
				this.userId === 0 &&
				this.userIdStatus !== UserIDStatus.Available
			) {
				throw new ZWaveError(
					`${this.constructor.name}: User ID 0 may only be used to clear all user codes`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			} else if (this.userIdStatus === UserIDStatus.Available) {
				this.userCode = "\x00".repeat(4);
			} else {
				this.userCode = options.userCode!;
				if (!/^[0-9]{4,10}$/.test(this.userCode)) {
					throw new ZWaveError(
						`${this.constructor.name}: The user code must consist of 4 to 10 numeric digits in ASCII representation.`,
						ZWaveErrorCodes.Argument_Invalid,
					);
				}
			}
		}
	}

	public userId: number;
	public userIdStatus: UserIDStatus;
	public userCode: string;

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([this.userId, this.userIdStatus]),
			Buffer.from(this.userCode, "ascii"),
		]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: [
				`user id:   ${this.userId}`,
				`id status: ${getEnumMemberName(
					UserIDStatus,
					this.userIdStatus,
				)}`,
				`user code: ${this.userCode}`,
			],
		};
	}
}

@CCCommand(UserCodeCommand.Report)
export class UserCodeCCReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 6);
		this.userId = this.payload[0];
		this.userIdStatus = this.payload[1];
		this.userCode = this.payload.slice(2).toString("ascii");
		this.persistValues();
	}

	public readonly userId: number;
	public readonly userIdStatus: UserIDStatus;
	public readonly userCode: string;

	public persistValues(): boolean {
		persistUserCode.call(
			this,
			this.userId,
			this.userIdStatus,
			this.userCode,
		);
		return true;
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: [
				`user id:   ${this.userId}`,
				`id status: ${getEnumMemberName(
					UserIDStatus,
					this.userIdStatus,
				)}`,
				`user code: ${this.userCode}`,
			],
		};
	}
}

interface UserCodeCCGetOptions extends CCCommandOptions {
	userId: number;
}

@CCCommand(UserCodeCommand.Get)
@expectedCCResponse(UserCodeCCReport)
export class UserCodeCCGet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | UserCodeCCGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.userId = options.userId;
		}
	}

	public userId: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.userId]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `user id: ${this.userId}`,
		};
	}
}

@CCCommand(UserCodeCommand.UsersNumberReport)
export class UserCodeCCUsersNumberReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		if (this.payload.length >= 3) {
			// V2+
			this.supportedUsers = this.payload.readUInt16BE(1);
		} else {
			// V1
			this.supportedUsers = this.payload[0];
		}
		this.persistValues();
	}

	@ccValue({ internal: true })
	public readonly supportedUsers: number;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `supported users: ${this.supportedUsers}`,
		};
	}
}

@CCCommand(UserCodeCommand.UsersNumberGet)
@expectedCCResponse(UserCodeCCUsersNumberReport)
export class UserCodeCCUsersNumberGet extends UserCodeCC {}

@CCCommand(UserCodeCommand.CapabilitiesReport)
export class UserCodeCCCapabilitiesReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		let offset = 0;

		validatePayload(this.payload.length >= offset + 1);
		this.supportsMasterCode = !!(this.payload[offset] & 0b100_00000);
		this.supportsMasterCodeDeactivation = !!(
			this.payload[offset] & 0b010_00000
		);
		const statusBitMaskLength = this.payload[offset] & 0b000_11111;
		offset += 1;

		validatePayload(
			this.payload.length >= offset + statusBitMaskLength + 1,
		);
		this.supportedUserIDStatuses = parseBitMask(
			this.payload.slice(offset, offset + statusBitMaskLength),
			UserIDStatus.Available,
		);
		offset += statusBitMaskLength;

		this.supportsUserCodeChecksum = !!(this.payload[offset] & 0b100_00000);
		this.supportsMultipleUserCodeReport = !!(
			this.payload[offset] & 0b010_00000
		);
		this.supportsMultipleUserCodeSet = !!(
			this.payload[offset] & 0b001_00000
		);
		const keypadModesBitMaskLength = this.payload[offset] & 0b000_11111;
		offset += 1;

		validatePayload(
			this.payload.length >= offset + keypadModesBitMaskLength + 1,
		);
		this.supportedKeypadModes = parseBitMask(
			this.payload.slice(offset, offset + keypadModesBitMaskLength),
			KeypadMode.Normal,
		);
		offset += keypadModesBitMaskLength;

		const keysBitMaskLength = this.payload[offset] & 0b000_11111;
		offset += 1;

		validatePayload(this.payload.length >= offset + keysBitMaskLength);
		this.supportedASCIIChars = Buffer.from(
			parseBitMask(
				this.payload.slice(offset, offset + keysBitMaskLength),
				0,
			),
		).toString("ascii");

		this.persistValues();
	}

	@ccValue({ internal: true })
	public readonly supportsMasterCode: boolean;
	@ccValue({ internal: true })
	public readonly supportsMasterCodeDeactivation: boolean;
	@ccValue({ internal: true })
	public readonly supportsUserCodeChecksum: boolean;
	@ccValue({ internal: true })
	public readonly supportsMultipleUserCodeReport: boolean;
	@ccValue({ internal: true })
	public readonly supportsMultipleUserCodeSet: boolean;
	@ccValue({ internal: true })
	public readonly supportedUserIDStatuses: readonly UserIDStatus[];
	@ccValue({ internal: true })
	public readonly supportedKeypadModes: readonly KeypadMode[];
	@ccValue({ internal: true })
	public readonly supportedASCIIChars: string;
}

@CCCommand(UserCodeCommand.CapabilitiesGet)
@expectedCCResponse(UserCodeCCCapabilitiesReport)
export class UserCodeCCCapabilitiesGet extends UserCodeCC {}

interface UserCodeCCKeypadModeSetOptions extends CCCommandOptions {
	keypadMode: KeypadMode;
}

@CCCommand(UserCodeCommand.KeypadModeSet)
export class UserCodeCCKeypadModeSet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| UserCodeCCKeypadModeSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if (!this.interviewComplete) {
				throw new ZWaveError(
					`${this.constructor.name}: This CC can only be used after the interview is complete!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.keypadMode = options.keypadMode;

			const supportedModes =
				this.getNode()?.getValue<KeypadMode[]>(
					getSupportedKeypadModesValueID(this.endpointIndex),
				) ?? [];

			if (!supportedModes.includes(this.keypadMode)) {
				throw new ZWaveError(
					`${
						this.constructor.name
					}: The keypad mode ${getEnumMemberName(
						KeypadMode,
						this.keypadMode,
					)} is not supported by the node!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}
	}

	public keypadMode: KeypadMode;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.keypadMode]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `mode: ${getEnumMemberName(KeypadMode, this.keypadMode)}`,
		};
	}
}

@CCCommand(UserCodeCommand.KeypadModeReport)
export class UserCodeCCKeypadModeReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		this.keypadMode = this.payload[0];
		this.persistValues();
	}

	public persistValues(): boolean {
		if (!super.persistValues()) return false;
		// Update the keypad modes metadata
		const supportedKeypadModes = this.getValueDB().getValue<KeypadMode[]>(
			getSupportedKeypadModesValueID(this.endpointIndex),
		) ?? [this.keypadMode];

		const valueId = getKeypadModeValueID(this.endpointIndex);
		this.getValueDB().setMetadata(valueId, {
			...ValueMetadata.ReadOnlyNumber,
			label: "Keypad Mode",
			states: enumValuesToMetadataStates(
				KeypadMode,
				supportedKeypadModes,
			),
		});

		return true;
	}

	@ccValue({ minVersion: 2 })
	public readonly keypadMode: KeypadMode;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `keypadMode: ${getEnumMemberName(
				KeypadMode,
				this.keypadMode,
			)}`,
		};
	}
}

@CCCommand(UserCodeCommand.KeypadModeGet)
@expectedCCResponse(UserCodeCCKeypadModeReport)
export class UserCodeCCKeypadModeGet extends UserCodeCC {}

interface UserCodeCCMasterCodeSetOptions extends CCCommandOptions {
	masterCode: string;
}

@CCCommand(UserCodeCommand.MasterCodeSet)
export class UserCodeCCMasterCodeSet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| UserCodeCCMasterCodeSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if (!this.interviewComplete) {
				throw new ZWaveError(
					`${this.constructor.name}: This CC can only be used after the interview is complete!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			const supportedAsciiChars =
				this.getNode()?.getValue<string>(
					getSupportedASCIICharsValueID(this.endpointIndex),
				) ?? "";

			this.masterCode = options.masterCode;

			// Validate the code
			if (!this.masterCode) {
				const supportsDeactivation =
					this.getNode()?.getValue<boolean>(
						getSupportsMasterCodeDeactivationValueID(
							this.endpointIndex,
						),
					) ?? false;
				if (!supportsDeactivation) {
					throw new ZWaveError(
						`${this.constructor.name}: The node does not support deactivating the master code!`,
						ZWaveErrorCodes.Argument_Invalid,
					);
				}
			} else if (!validateCode(this.masterCode, supportedAsciiChars)) {
				throw new ZWaveError(
					`${this.constructor.name}: The master code must consist of 4 to 10 of the following characters: ${supportedAsciiChars}`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
		}
	}

	public masterCode: string;

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([this.masterCode.length & 0b11111]),
			Buffer.from(this.masterCode, "ascii"),
		]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `master code: ${this.masterCode}`,
		};
	}
}

@CCCommand(UserCodeCommand.MasterCodeReport)
export class UserCodeCCMasterCodeReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		const codeLength = this.payload[0] & 0b1111;
		validatePayload(this.payload.length >= 1 + codeLength);
		this.masterCode = this.payload
			.slice(1, 1 + codeLength)
			.toString("ascii");
		this.persistValues();
	}

	@ccValue({ minVersion: 2 })
	@ccValueMetadata({
		...ValueMetadata.String,
		label: "Master Code",
		minLength: 4,
		maxLength: 10,
	})
	public readonly masterCode: string;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `master code: ${this.masterCode}`,
		};
	}
}

@CCCommand(UserCodeCommand.MasterCodeGet)
@expectedCCResponse(UserCodeCCMasterCodeReport)
export class UserCodeCCMasterCodeGet extends UserCodeCC {}

@CCCommand(UserCodeCommand.UserCodeChecksumReport)
export class UserCodeCCUserCodeChecksumReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 2);
		this.userCodeChecksum = this.payload.readUInt16BE(0);
		this.persistValues();
	}

	@ccValue({ internal: true })
	public readonly userCodeChecksum: number;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `user code checksum: ${num2hex(this.userCodeChecksum)}`,
		};
	}
}

@CCCommand(UserCodeCommand.UserCodeChecksumGet)
@expectedCCResponse(UserCodeCCUserCodeChecksumReport)
export class UserCodeCCUserCodeChecksumGet extends UserCodeCC {}

export interface UserCodeCCExtendedUserCodeSetOptions extends CCCommandOptions {
	userCodes: UserCodeCCSetOptions[];
}

export interface UserCode {
	userId: number;
	userIdStatus: UserIDStatus;
	userCode: string;
}

export type SettableUserCode = UserCode & {
	userIdStatus: Exclude<UserIDStatus, UserIDStatus.StatusNotAvailable>;
};

@CCCommand(UserCodeCommand.ExtendedUserCodeSet)
export class UserCodeCCExtendedUserCodeSet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| UserCodeCCExtendedUserCodeSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if (!this.interviewComplete) {
				throw new ZWaveError(
					`${this.constructor.name}: This CC can only be used after the interview is complete!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.userCodes = options.userCodes as any;

			const numUsers =
				this.getNode()?.getValue<number>(
					getSupportedUsersValueID(this.endpointIndex),
				) ?? 0;
			const supportedStatuses =
				this.getNode()?.getValue<number[]>(
					getSupportedUserIDStatusesValueID(this.endpointIndex),
				) ?? [];
			const supportedAsciiChars =
				this.getNode()?.getValue<string>(
					getSupportedASCIICharsValueID(this.endpointIndex),
				) ?? "";
			const supportsMultipleUserCodeSet =
				this.getNode()?.getValue<boolean>(
					getSupportsMultipleUserCodeSetValueID(this.endpointIndex),
				) ?? false;

			// Validate options
			if (
				this.userCodes.some(
					(code) => code.userId < 0 || code.userId > numUsers,
				)
			) {
				throw new ZWaveError(
					`${this.constructor.name}: The user ID must be between 0 and the number of supported users ${numUsers}.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			} else if (
				this.userCodes.some((code) => code.userId === 0) &&
				this.userCodes.length > 1
			) {
				throw new ZWaveError(
					`${this.constructor.name}: If user ID 0 is used, only one code may be set`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			} else if (
				this.userCodes.some(
					(code) =>
						code.userId === 0 &&
						code.userIdStatus !== UserIDStatus.Available,
				)
			) {
				throw new ZWaveError(
					`${this.constructor.name}: User ID 0 may only be used to clear all user codes`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			} else if (
				this.userCodes.length > 1 &&
				!supportsMultipleUserCodeSet
			) {
				throw new ZWaveError(
					`${this.constructor.name}: The node does not support setting multiple user codes at once`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}

			for (const code of this.userCodes) {
				if (!supportedStatuses.includes(code.userIdStatus)) {
					throw new ZWaveError(
						`${
							this.constructor.name
						}: The user ID status ${getEnumMemberName(
							UserIDStatus,
							code.userIdStatus,
						)} is not supported by the node`,
						ZWaveErrorCodes.Argument_Invalid,
					);
				} else if (code.userIdStatus === UserIDStatus.Available) {
					code.userCode = "";
				} else {
					if (!validateCode(code.userCode, supportedAsciiChars)) {
						throw new ZWaveError(
							`${this.constructor.name}: The user code must consist of 4 to 10 of the following characters: ${supportedAsciiChars}`,
							ZWaveErrorCodes.Argument_Invalid,
						);
					}
				}
			}
		}
	}

	public userCodes: SettableUserCode[];

	public serialize(): Buffer {
		const userCodeBuffers = this.userCodes.map((code) => {
			const ret = Buffer.concat([
				Buffer.from([0, 0, code.userIdStatus, code.userCode.length]),
				Buffer.from(code.userCode, "ascii"),
			]);
			ret.writeUInt16BE(code.userId, 0);
			return ret;
		});
		this.payload = Buffer.concat([
			Buffer.from([this.userCodes.length]),
			...userCodeBuffers,
		]);
		return super.serialize();
	}
}

@CCCommand(UserCodeCommand.ExtendedUserCodeReport)
export class UserCodeCCExtendedUserCodeReport extends UserCodeCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		const numCodes = this.payload[0];
		let offset = 1;
		const userCodes: UserCode[] = [];
		// parse each user code
		for (let i = 0; i < numCodes; i++) {
			const { code, bytesRead } = parseExtendedUserCode(
				this.payload.slice(offset),
			);
			userCodes.push(code);
			offset += bytesRead;
		}
		this.userCodes = userCodes;

		validatePayload(this.payload.length >= offset + 2);
		this.nextUserId = this.payload.readUInt16BE(offset);

		this.persistValues();
	}

	public persistValues(): boolean {
		for (const { userId, userIdStatus, userCode } of this.userCodes) {
			persistUserCode.call(this, userId, userIdStatus, userCode);
		}
		return true;
	}

	public readonly userCodes: readonly UserCode[];
	public readonly nextUserId: number;
}

interface UserCodeCCExtendedUserCodeGetOptions extends CCCommandOptions {
	userId: number;
	reportMore?: boolean;
}

@CCCommand(UserCodeCommand.ExtendedUserCodeGet)
@expectedCCResponse(UserCodeCCExtendedUserCodeReport)
export class UserCodeCCExtendedUserCodeGet extends UserCodeCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| UserCodeCCExtendedUserCodeGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.userId = options.userId;
			this.reportMore = !!options.reportMore;
		}
	}

	public userId: number;
	public reportMore: boolean;

	public serialize(): Buffer {
		this.payload = Buffer.from([0, 0, this.reportMore ? 1 : 0]);
		this.payload.writeUInt16BE(this.userId, 0);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: [
				`user id:     ${this.userId}`,
				`report more: ${this.reportMore}`,
			],
		};
	}
}
