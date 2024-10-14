export const beforeIterateCommandExampleDiagram = `
classDiagram
    Animal <|-- Duck
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Duck{
      +String beakColor
      +swim()
      +quack()
    }
    class Fish{
      -int sizeInFeet
      -canEat()
    }
    class Zebra{
      +bool is_wild
      +run()
    }
`;

export const afterIterateCommandExampleDiagram = `
classDiagram
    Animal <|-- Bunny
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +double age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Bunny{
      +String beakColor
      +swim()
      +quack()
    }
    class Fish{
      -double sizeInFeet
      -canEat()
    }
    class Zebra{
      +bool is_wild
      +run()
    }
`;