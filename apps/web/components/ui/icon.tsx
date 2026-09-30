import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { ComponentType } from "react";
import {
  faArrowDownUpAcrossLine,
  faArrowLeft,
  faArrowTrendUp,
  faArrowUpRightFromSquare,
  faBagShopping,
  faBarcode,
  faBars,
  faBell,
  faBox,
  faBoxArchive,
  faBoxOpen,
  faBoxesStacked,
  faBuilding,
  faChartLine,
  faCamera,
  faCameraRotate,
  faCheck,
  faCheckDouble,
  faCircleCheck,
  faCircleDollarToSlot,
  faCircleExclamation,
  faCircleInfo,
  faCirclePause,
  faCartShopping,
  faClock,
  faComment,
  faCommentDots,
  faCreditCard,
  faDownload,
  faEnvelope,
  faFileLines,
  faGear,
  faGaugeHigh,
  faIdCard,
  faLifeRing,
  faList,
  faMagnifyingGlass,
  faMapLocationDot,
  faPaperPlane,
  faPrint,
  faReceipt,
  faRepeat,
  faRightFromBracket,
  faRotateLeft,
  faShieldHalved,
  faSpinner,
  faTableColumns,
  faTriangleExclamation,
  faUser,
  faUserPlus,
  faUsers,
  faWallet,
  faXmark,
  faChevronDown,
  faChevronUp,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon, type FontAwesomeIconProps } from "@fortawesome/react-fontawesome";

export type AppIconProps = Omit<FontAwesomeIconProps, "icon" | "size"> & {
  /** Preserves the numeric sizing API used by the previous icon system. */
  size?: number | string;
  /** Accepted for migration compatibility; Font Awesome icons do not use strokes. */
  strokeWidth?: number;
};

export type AppIcon = ComponentType<AppIconProps>;

function createIcon(icon: IconDefinition, defaults?: Pick<AppIconProps, "spin">): AppIcon {
  return function Icon({ size, style, strokeWidth, "aria-label": ariaLabel, ...props }) {
    void strokeWidth;
    const dimension = typeof size === "number" ? `${size}px` : size;

    return (
      <FontAwesomeIcon
        icon={icon}
        aria-hidden={ariaLabel ? undefined : true}
        {...defaults}
        {...props}
        aria-label={ariaLabel}
        style={dimension ? { ...style, width: dimension, height: dimension } : style}
      />
    );
  };
}

// Names intentionally mirror the prior call sites. Keeping the mapping here
// prevents arbitrary icon imports and makes every substitution reviewable.
export const Activity = createIcon(faChartLine);
export const AlertTriangle = createIcon(faTriangleExclamation);
export const ArrowLeft = createIcon(faArrowLeft);
export const ArrowUpDown = createIcon(faArrowDownUpAcrossLine);
export const ArrowUpRight = createIcon(faArrowUpRightFromSquare);
export const Barcode = createIcon(faBarcode);
export const Bell = createIcon(faBell);
export const Boxes = createIcon(faBoxesStacked);
export const Building2 = createIcon(faBuilding);
export const Camera = createIcon(faCamera);
export const CameraRotate = createIcon(faCameraRotate);
export const Check = createIcon(faCheck);
export const CheckCheck = createIcon(faCheckDouble);
export const CheckCircle2 = createIcon(faCircleCheck);
export const CheckIcon = createIcon(faCheck);
export const ChevronDownIcon = createIcon(faChevronDown);
export const ChevronUpIcon = createIcon(faChevronUp);
export const CircleAlert = createIcon(faCircleExclamation);
export const CircleDollarSign = createIcon(faCircleDollarToSlot);
export const Clock = createIcon(faClock);
export const CreditCard = createIcon(faCreditCard);
export const Download = createIcon(faDownload);
export const FileClock = createIcon(faFileLines);
export const FileText = createIcon(faFileLines);
export const Gauge = createIcon(faGaugeHigh);
export const IdCard = createIcon(faIdCard);
export const Info = createIcon(faCircleInfo);
export const LayoutDashboard = createIcon(faTableColumns);
export const LifeBuoy = createIcon(faLifeRing);
export const LineChart = createIcon(faChartLine);
export const ListTree = createIcon(faList);
export const Loader2 = createIcon(faSpinner, { spin: true });
export const LogOut = createIcon(faRightFromBracket);
export const Mail = createIcon(faEnvelope);
export const MapPinOff = createIcon(faMapLocationDot);
export const Menu = createIcon(faBars);
export const MessageCircle = createIcon(faComment);
export const MessageCircleWarning = createIcon(faCommentDots);
export const Package = createIcon(faBox);
export const PackageCheck = createIcon(faBoxOpen);
export const PackageMinus = createIcon(faBoxArchive);
export const PackageSearch = createIcon(faBoxOpen);
export const PackageX = createIcon(faBoxArchive);
export const PauseCircle = createIcon(faCirclePause);
export const Printer = createIcon(faPrint);
export const Receipt = createIcon(faReceipt);
export const Repeat = createIcon(faRepeat);
export const Search = createIcon(faMagnifyingGlass);
export const Send = createIcon(faPaperPlane);
export const Settings = createIcon(faGear);
export const ShieldAlert = createIcon(faShieldHalved);
export const ShieldCheck = createIcon(faShieldHalved);
export const ShoppingBag = createIcon(faBagShopping);
export const ShoppingCart = createIcon(faCartShopping);
export const TrendingUp = createIcon(faArrowTrendUp);
export const Undo2 = createIcon(faRotateLeft);
export const UserPlus = createIcon(faUserPlus);
export const UserRound = createIcon(faUser);
export const Users = createIcon(faUsers);
export const Users2 = createIcon(faUsers);
export const Wallet = createIcon(faWallet);
export const X = createIcon(faXmark);
export const XCircle = createIcon(faXmark);
export const XIcon = createIcon(faXmark);
