import "./brand.css";

// Geometry from src/assets/brand/unhollowed-butterfly-symbol-dark.svg, one entry
// per wing: upper left, upper right, lower left, lower right.
const wings = [
  {
    paths: [
      "M 613 637 C 595 546 552 476 475 433 C 434 400 378 380 325 385 C 303 430 289 477 305 525 C 314 551 322 576 328 590 C 342 618 367 637 401 634 C 435 635 454 621 488 626 C 532 625 576 643 587 649 C 601 655 608 650 613 637 Z",
      "M 325 385 C 355 409 373 447 375 486 C 356 516 339 559 328 590",
      "M 375 486 C 416 473 447 456 475 433 C 475 468 482 502 494 534",
      "M 375 486 C 405 514 449 527 494 534 C 553 533 592 576 613 637",
      "M 494 534 C 456 567 424 599 401 634",
    ],
    nodes: [
      [325, 385, 19],
      [375, 486, 15],
      [475, 433, 15],
      [494, 534, 16],
      [328, 590, 15],
      [401, 634, 15],
    ],
  },
  {
    paths: [
      "M 640 637 C 658 555 705 494 755 453 C 799 414 853 374 925 382 C 949 417 961 454 950 492 C 943 524 924 567 903 596 C 878 638 826 658 762 647 C 723 639 688 644 665 653 C 651 657 645 648 640 637 Z",
      "M 925 382 C 897 409 874 445 859 473 C 879 500 897 559 903 596",
      "M 755 453 C 773 479 786 508 793 536 C 771 579 767 620 762 647",
      "M 859 473 C 844 492 814 513 793 536 C 832 554 873 578 903 596",
      "M 793 536 C 725 550 680 582 640 637",
    ],
    nodes: [
      [925, 382, 19],
      [859, 473, 15],
      [755, 453, 15],
      [793, 536, 16],
      [903, 596, 15],
      [762, 647, 15],
    ],
  },
  {
    paths: [
      "M 609 686 C 591 750 585 815 522 854 C 477 873 424 855 375 874 C 342 834 341 789 371 733 C 404 687 460 681 515 673 C 550 666 586 660 609 686 Z",
      "M 371 733 C 412 738 444 757 470 776 C 480 808 500 836 522 854",
      "M 515 673 C 490 701 477 738 470 776 C 430 796 397 827 375 874",
      "M 470 776 C 523 774 575 740 609 686",
    ],
    nodes: [
      [371, 733, 15],
      [515, 673, 15],
      [470, 776, 16],
      [522, 854, 15],
      [375, 874, 18],
    ],
  },
  {
    paths: [
      "M 642 687 C 665 663 720 663 776 680 C 833 693 876 731 888 770 C 886 809 858 837 847 879 C 798 894 749 876 714 847 C 668 811 659 747 642 687 Z",
      "M 642 687 C 665 731 697 769 729 794 C 781 808 823 839 847 879",
      "M 648 683 C 710 683 752 698 794 715 C 836 730 866 751 888 770",
      "M 714 847 C 725 826 730 808 729 794 C 746 766 769 741 794 715",
    ],
    nodes: [
      [794, 715, 15],
      [888, 770, 15],
      [729, 794, 16],
      [714, 847, 15],
      [847, 879, 18],
    ],
  },
] as const;

/**
 * The Unhollowed butterfly: wings drawn as connected nodes. It strokes in
 * with currentColor, so it follows the surrounding text color. `animate`
 * draws the lines in on mount and lets the wings flutter on hover.
 */
export function BrandMark({
  size = 28,
  animate = false,
  className = "",
}: {
  size?: number;
  animate?: boolean;
  className?: string;
}) {
  // Keep lines about 1.5px wide on screen, however small the mark is drawn,
  // and grow the nodes with them so the butterfly reads at sidebar size.
  const stroke = Math.max(10.5, (1.5 * 680) / size);
  const grow = Math.min(2.2, stroke / 12);
  return (
    <svg
      className={`brand-mark${animate ? " is-animated" : ""} ${className}`}
      width={size}
      height={(size * 550) / 680}
      viewBox="286 355 680 550"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {wings.map(({ paths, nodes }, wing) => (
        <g key={wing} className={`brand-wing brand-wing-${wing}`}>
          {paths.map((d) => (
            <path
              key={d}
              d={d}
              pathLength={1}
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {nodes.map(([cx, cy, r]) => (
            <circle
              key={`${cx}-${cy}`}
              cx={cx}
              cy={cy}
              r={r * Math.max(1, grow)}
              fill="currentColor"
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
