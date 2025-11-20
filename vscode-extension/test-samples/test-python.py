# This is a single-line comment
def calculate_distance(x1, y1, x2, y2):
    """Calculate Euclidean distance between two points."""
    # Calculate differences
    dx = x2 - x1  # horizontal distance
    dy = y2 - y1  # vertical distance

    # Return the distance using Pythagorean theorem
    return (dx ** 2 + dy ** 2) ** 0.5

'''
Multi-line comment block
This should be preserved as it might be a docstring
'''

class GameBot:
    # Class-level comment
    def __init__(self):
        self.position = (0, 0)  # Starting position
        self.moves = []

    def move(self, x, y):
        # Update position
        self.position = (x, y)
        self.moves.append(self.position)  # Track history

    def get_strategy(self):
        """Returns the current strategy."""
        # TODO: Implement advanced strategy
        return "basic"  # Default strategy

# Main game loop
def main():
    bot = GameBot()
    # Process game state
    bot.move(5, 10)
    print(bot.position)  # Debug output

if __name__ == "__main__":
    main()
